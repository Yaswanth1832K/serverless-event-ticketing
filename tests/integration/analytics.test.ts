import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  loadOutputs, createUser, createStaffUser, deleteUser, api, futureDate, eventually, waitForRoutes,
  waitForStreamMapping, invokeStreamProcessor, dlqDepth, ticketsInDb, purgeEvent, timed, stats,
  type Outputs, type TestUser,
} from './helpers';

// Analytics against the DEPLOYED stack: DynamoDB Streams -> stream-processor -> counters.
let out: Outputs;
let orgA: TestUser, orgB: TestUser, staff: TestUser, stranger: TestUser;
let buyers: TestUser[];
let big: string, small: string, canaryEvent: string; // big: capacity 20, small: capacity 12
const events: string[] = [];

interface T { ticketId: string; token: string }
const bigTickets: T[] = [];
const smallTickets: T[] = [];

async function newEvent(label: string, capacity: number): Promise<string> {
  const r = await api(out, 'POST', '/events', orgA.token, {
    name: `ANALYTICS-TEST ${label}`, description: 'Automated test. Safe to delete.', venue: 'Gate',
    startsAt: futureDate(30), priceCents: 100, capacity,
  });
  expect(r.status, r.raw).toBe(201);
  events.push(r.body.eventId);
  return r.body.eventId;
}

// Books `n` tickets for an event across the buyers (5 per request) and fetches each real QR token.
async function bookAndGetTokens(eventId: string, n: number, into: T[]) {
  const bookings = [];
  for (let i = 0; i * 5 < n; i++) {
    bookings.push(api(out, 'POST', `/events/${eventId}/book`, buyers[i % buyers.length]!.token, { quantity: Math.min(5, n - i * 5) }));
  }
  const done = await Promise.all(bookings);
  for (const [i, b] of done.entries()) {
    expect(b.status, b.raw).toBe(201);
    const buyer = buyers[i % buyers.length]!;
    for (const t of b.body.tickets) {
      const q = await api(out, 'GET', `/events/${eventId}/tickets/${t.ticketId}/qr`, buyer.token);
      expect(q.status, q.raw).toBe(200);
      into.push({ ticketId: t.ticketId, token: q.body.token });
    }
  }
}

const scan = (eventId: string, token: string, who: TestUser = staff) =>
  api(out, 'POST', '/checkin', who.token, { token, eventId });
const analytics = (eventId: string, who: TestUser = orgA) => api(out, 'GET', `/events/${eventId}/analytics`, who.token);

// "Enabled" is NOT a reliable readiness signal. On the first deploy the trigger reported Enabled
// for over a minute while the first check-in was never delivered (StartingPosition LATEST skips
// records written before the poller attaches). So prove the pipeline end to end first: run a canary
// check-in and wait until it appears in a counter. Nothing else in this file runs before that.
function countBy(values: number[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
}

async function proveStreamIsLive() {
  await waitForStreamMapping(out);
  canaryEvent = await newEvent('canary', 5);
  const canary = canaryEvent;
  const tickets: T[] = [];
  await bookAndGetTokens(canary, 1, tickets);
  const deadline = Date.now() + 240_000;
  for (;;) {
    // re-scanning the canary is safe: only the first scan can succeed
    await scan(canary, tickets[0]!.token);
    const a = (await analytics(canary)).body;
    if (a.checkedIn >= 1) return;
    if (Date.now() > deadline) throw new Error('Stream pipeline did not count a canary check-in within 4 minutes');
    await new Promise((r) => setTimeout(r, 5000));
  }
}

const bucketSum = (a: any) => (a.checkInsOverTime as { count: number }[]).reduce((n, b) => n + b.count, 0);

beforeAll(async () => {
  out = loadOutputs();
  const users = await Promise.all([
    createUser(out, 'Organizer', 'an-orgA'),
    createUser(out, 'Organizer', 'an-orgB'),
    createStaffUser(out, 'an-staff'),
    createUser(out, 'Attendee', 'an-stranger'),
    ...Array.from({ length: 4 }, (_, i) => createUser(out, 'Attendee', `an-buyer${i}`)),
  ]);
  [orgA, orgB, staff, stranger] = users as [TestUser, TestUser, TestUser, TestUser];
  buyers = users.slice(4);
  await waitForRoutes(out, stranger.token);
  await proveStreamIsLive();
  big = await newEvent('big', 20);
  small = await newEvent('small', 12);
  await bookAndGetTokens(big, 20, bigTickets);
  await bookAndGetTokens(small, 8, smallTickets);
}, 240_000);

afterAll(async () => {
  for (const id of events) await purgeEvent(out, id);
  await Promise.all([orgA, orgB, staff, stranger, ...buyers].map((u) => deleteUser(out, u.email)));
}, 120_000);

describe('access control: analytics are private to the owning organizer', () => {
  it('an Attendee gets 403 on both endpoints (and sees no numbers)', async () => {
    const a = await analytics(big, stranger);
    expect(a.status).toBe(403);
    expect(a.raw).not.toContain('"sold"');
    const d = await api(out, 'GET', '/dashboard', stranger.token);
    expect(d.status).toBe(403);
    expect(d.raw).not.toContain('totals');
    // also a buyer who really holds tickets for that event
    expect((await analytics(big, buyers[0]!)).status).toBe(403);
  });
  it('Staff get 403 as well', async () => {
    expect((await analytics(big, staff)).status).toBe(403);
    expect((await api(out, 'GET', '/dashboard', staff.token)).status).toBe(403);
  });
  it("another organizer cannot read organizer A's event analytics (403) and sees none of its events on the dashboard", async () => {
    const a = await analytics(big, orgB);
    expect(a.status).toBe(403);
    expect(a.raw).not.toContain('"sold"');
    const d = await api(out, 'GET', '/dashboard', orgB.token);
    expect(d.status).toBe(200);
    expect(d.body.totals).toEqual({ totalEvents: 0, ticketsSold: 0, remaining: 0, checkedIn: 0, attendancePct: 0 });
    expect(d.raw).not.toContain(big);
  });
  it('anonymous gets 401, unknown and malformed event ids get 404', async () => {
    expect((await api(out, 'GET', `/events/${big}/analytics`)).status).toBe(401);
    expect((await api(out, 'GET', '/dashboard')).status).toBe(401);
    expect((await analytics('00000000-0000-4000-8000-0000000000aa')).status).toBe(404);
    expect((await analytics('not-a-uuid')).status).toBe(404);
  });
});

describe('before any check-in', () => {
  it('sold counters already match the real tickets, and checked-in is 0', async () => {
    const a = (await analytics(big)).body;
    const db = await ticketsInDb(out, big);
    expect(db).toEqual({ total: 20, checkedIn: 0, booked: 20 });
    expect(a).toMatchObject({ sold: 20, remaining: 0, checkedIn: 0, attendancePct: 0, capacity: 20 });
    expect(a.checkInsOverTime).toEqual([]);
  });
});

describe('one check-in: near-real-time delay', () => {
  it('the counter reflects a scan within a few seconds', async () => {
    const t = smallTickets[0]!;
    const r = await scan(small, t.token);
    expect(r.status, r.raw).toBe(200);
    const t0 = Date.now();
    let a: any;
    for (;;) {
      a = (await analytics(small)).body;
      if (a.checkedIn >= 1 || Date.now() - t0 > 60_000) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    const lag = Date.now() - t0;
    console.log(`[stream lag] scan acknowledged -> counter visible in the analytics endpoint after ${lag}ms`);
    expect(a.checkedIn).toBe(1);
    expect(bucketSum(a)).toBe(1);
  }, 90_000);
});

describe('idempotency: a replayed stream batch does not count twice', () => {
  it('delivering the same record twice, in two invocations, leaves every counter unchanged', async () => {
    const t = smallTickets[0]!; // already checked in and counted above
    const before = (await analytics(small)).body;
    expect(before.checkedIn).toBe(1);

    const s = (v: string) => ({ S: v });
    const image = (status: string) => ({
      PK: s(`EVENT#${small}`), SK: s(`TICKET#${t.ticketId}`), entity: s('TICKET'), ticketId: s(t.ticketId),
      eventId: s(small), status: s(status), checkedInAt: s(new Date().toISOString()),
    });
    // exactly what DynamoDB Streams would redeliver for this ticket's BOOKED -> CHECKED_IN change
    const rec = {
      eventID: 'replay-1', eventName: 'MODIFY', eventSource: 'aws:dynamodb',
      dynamodb: { SequenceNumber: '900000000000000000001', OldImage: image('BOOKED'), NewImage: image('CHECKED_IN') },
    };
    const batch = { Records: [rec, rec] }; // duplicate inside the batch too

    for (let i = 1; i <= 2; i++) {
      const res = await invokeStreamProcessor(out, batch);
      expect(res.functionError, `invocation ${i}`).toBeUndefined();
      expect(res.result).toEqual({ batchItemFailures: [] });
    }
    const after = (await analytics(small)).body;
    expect(after.checkedIn).toBe(1);
    expect(bucketSum(after)).toBe(1);
    expect(after.checkInsOverTime).toEqual(before.checkInsOverTime);
    // and it still equals the truth in the table
    expect((await ticketsInDb(out, small)).checkedIn).toBe(1);
  }, 60_000);
});

describe('20 check-ins on one event', () => {
  it('give a checked-in count of exactly 20, and it stays 20', async () => {
    expect(bigTickets).toHaveLength(20);
    const t0 = Date.now();
    const results = await Promise.all(bigTickets.map((t, i) => scan(big, t.token, i % 2 ? staff : orgA)));
    console.log(`[20 check-ins] 20 simultaneous scans on one event took ${Date.now() - t0}ms, statuses ${JSON.stringify(countBy(results.map((r) => r.status)))}`);
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(200));

    const a = await eventually(() => analytics(big), (r) => r.body.checkedIn >= 20, 60, 500);
    expect(a.body.checkedIn).toBe(20);
    expect(a.body.attendancePct).toBe(100);
    expect(bucketSum(a.body)).toBe(20);

    // stability: wait, then make sure nothing counted late or twice
    await new Promise((r) => setTimeout(r, 10_000));
    const later = (await analytics(big)).body;
    expect(later.checkedIn).toBe(20);
    expect(bucketSum(later)).toBe(20);
  }, 180_000);

  it('the dead-letter queue is still empty', async () => {
    expect(await dlqDepth(out)).toBe(0);
  });
});

describe('counters match the real tickets', () => {
  it('small event: 8 sold, 4 checked in (after more scans), counters equal the DynamoDB ticket items', async () => {
    const rest = smallTickets.slice(1, 4); // one is already in, so 3 more makes 4
    const r = await Promise.all(rest.map((t) => scan(small, t.token)));
    expect(r.map((x) => x.status)).toEqual([200, 200, 200]);

    const a = await eventually(() => analytics(small), (x) => x.body.checkedIn >= 4, 40, 500);
    const db = await ticketsInDb(out, small);
    expect(db).toEqual({ total: 8, checkedIn: 4, booked: 4 });
    expect(a.body.sold).toBe(db.total);
    expect(a.body.checkedIn).toBe(db.checkedIn);
    expect(a.body.remaining).toBe(12 - db.total);
    expect(a.body.attendancePct).toBe(50);
    expect(bucketSum(a.body)).toBe(db.checkedIn);
  }, 120_000);

  it('big event counters equal the ticket items too', async () => {
    const a = (await analytics(big)).body;
    const db = await ticketsInDb(out, big);
    expect(db).toEqual({ total: 20, checkedIn: 20, booked: 0 });
    expect(a.sold).toBe(db.total);
    expect(a.checkedIn).toBe(db.checkedIn);
  });

  it("the organizer dashboard totals equal the sum of the organizer's real tickets", async () => {
    // organizer A owns three events: the canary (1 ticket, checked in), big (20/20) and small (8 sold, 4 in)
    const truth = await Promise.all([canaryEvent, big, small].map((id) => ticketsInDb(out, id)));
    const sold = truth.reduce((n, t) => n + t.total, 0);
    const checkedIn = truth.reduce((n, t) => n + t.checkedIn, 0);
    const remaining = 5 - truth[0]!.total + (20 - truth[1]!.total) + (12 - truth[2]!.total);
    expect({ sold, checkedIn }).toEqual({ sold: 29, checkedIn: 25 });

    const d = await eventually(
      () => api(out, 'GET', '/dashboard', orgA.token),
      (r) => r.body?.totals?.checkedIn === checkedIn && r.body?.totals?.totalEvents === 3,
      40, 500,
    );
    expect(d.status).toBe(200);
    expect(d.body.totals).toEqual({
      totalEvents: 3,
      ticketsSold: sold,
      remaining,
      checkedIn,
      attendancePct: Math.round((checkedIn / sold) * 1000) / 10,
    });
    const row = (id: string) => d.body.events.find((e: any) => e.eventId === id);
    expect(row(big)).toMatchObject({ sold: 20, checkedIn: 20, capacity: 20 });
    expect(row(small)).toMatchObject({ sold: 8, checkedIn: 4, capacity: 12 });
    expect(row(canaryEvent)).toMatchObject({ sold: 1, checkedIn: 1, capacity: 5 });
    const seriesTotal = (d.body.checkInsOverTime as { count: number }[]).reduce((n, b) => n + b.count, 0);
    expect(seriesTotal).toBe(checkedIn);
  }, 90_000);
});

describe('dashboard endpoint response times', () => {
  it('measures sequential and concurrent calls', async () => {
    const seq = { dashboard: [] as number[], analytics: [] as number[] };
    for (let i = 0; i < 20; i++) {
      seq.dashboard.push((await timed(() => api(out, 'GET', '/dashboard', orgA.token))).ms);
      seq.analytics.push((await timed(() => analytics(big))).ms);
    }
    const conc = await Promise.all(Array.from({ length: 20 }, () => timed(() => api(out, 'GET', '/dashboard', orgA.token))));
    const concStatuses = conc.map((c) => c.value.status);
    console.log(`[response times] GET /dashboard              sequential x20: ${stats(seq.dashboard)}`);
    console.log(`[response times] GET /events/{id}/analytics  sequential x20: ${stats(seq.analytics)}`);
    console.log(`[response times] GET /dashboard              20 concurrent:  ${stats(conc.map((c) => c.ms))}`);
    expect(concStatuses.every((s) => s === 200)).toBe(true);
    // generous bound: this is a regression guard, not a benchmark (first calls may be cold starts)
    expect(Math.max(...seq.dashboard.slice(1))).toBeLessThan(3000);
  }, 120_000);
});
