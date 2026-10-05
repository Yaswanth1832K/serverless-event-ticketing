import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  loadOutputs, createUser, deleteUser, api, futureDate, eventually, waitForRoutes, purgeEvent,
  type Outputs, type TestUser,
} from '../integration/helpers';

// Overselling protection, tested against the DEPLOYED API with real Cognito tokens.
// 10 different attendees share the load, so no single token is reused for every request.
const ATTENDEES = 10;

let out: Outputs;
let organizer: TestUser;
let attendees: TestUser[];
const events: string[] = [];

interface Result {
  status: number;
  body: any;
  ms: number;
  userIndex: number;
  quantity: number;
}

async function newEvent(capacity: number, label: string): Promise<string> {
  const r = await api(out, 'POST', '/events', organizer.token, {
    name: `CONCURRENCY-TEST ${label}`,
    description: 'Automated overselling test. Safe to delete.',
    venue: 'Test',
    startsAt: futureDate(30),
    priceCents: 0,
    capacity,
  });
  expect(r.status, `create event failed: ${r.raw}`).toBe(201);
  events.push(r.body.eventId);
  return r.body.eventId;
}

// Fires every booking at the same moment (all requests are in flight together).
async function fire(eventId: string, quantities: number[]): Promise<{ results: Result[]; wallMs: number }> {
  const t0 = Date.now();
  const results = await Promise.all(
    quantities.map(async (quantity, i): Promise<Result> => {
      const userIndex = i % ATTENDEES;
      const s = Date.now();
      const r = await api(out, 'POST', `/events/${eventId}/book`, attendees[userIndex]!.token, { quantity });
      return { status: r.status, body: r.body, ms: Date.now() - s, userIndex, quantity };
    }),
  );
  return { results, wallMs: Date.now() - t0 };
}

function report(title: string, results: Result[], wallMs: number) {
  const hist: Record<string, number> = {};
  for (const r of results) hist[r.status] = (hist[r.status] ?? 0) + 1;
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))]!;
  console.log(
    `[${title}] ${results.length} parallel requests, status counts ${JSON.stringify(hist)}, ` +
      `latency p50=${pct(0.5)}ms p95=${pct(0.95)}ms max=${ms[ms.length - 1]}ms, wall=${wallMs}ms`,
  );
}

const count = (results: Result[], status: number) => results.filter((r) => r.status === status).length;
const ticketIds = (results: Result[]) =>
  results.filter((r) => r.status === 201).flatMap((r) => r.body.tickets.map((t: any) => t.ticketId as string));

async function soldCount(eventId: string): Promise<{ sold: number; remaining: number; capacity: number }> {
  const r = await api(out, 'GET', `/events/${eventId}`);
  expect(r.status).toBe(200);
  return r.body;
}

// Reads every attendee's "My Tickets" and returns the tickets that belong to this event.
// The list comes from a GSI (eventually consistent), so poll until the expected number appears.
async function storedTickets(eventId: string, expected: number) {
  const read = async () => {
    const lists = await Promise.all(attendees.map((a) => api(out, 'GET', '/my/tickets', a.token)));
    return lists.flatMap((l) => (l.body.tickets as any[]).filter((t) => t.eventId === eventId));
  };
  return eventually(read, (t) => t.length >= expected, 10, 1500);
}

beforeAll(async () => {
  out = loadOutputs();
  const [org, ...att] = await Promise.all([
    createUser(out, 'Organizer', 'conc-org'),
    ...Array.from({ length: ATTENDEES }, (_, i) => createUser(out, 'Attendee', `conc-att${i}`)),
  ]);
  organizer = org!;
  attendees = att;
  await waitForRoutes(out, attendees[0]!.token);
}, 120_000);

afterAll(async () => {
  for (const id of events) await purgeEvent(out, id);
  await Promise.all([organizer, ...attendees].map((u) => deleteUser(out, u.email)));
}, 120_000);

describe('booking validation and access (deployed API)', () => {
  it('rejects bad quantities, wrong roles and anonymous callers', async () => {
    const id = await newEvent(5, 'validation');
    for (const q of [0, 6, 1.5, '2', null]) {
      const r = await api(out, 'POST', `/events/${id}/book`, attendees[0]!.token, { quantity: q });
      expect(r.status, `quantity ${String(q)}`).toBe(400);
    }
    expect((await api(out, 'POST', `/events/${id}/book`, organizer.token, { quantity: 1 })).status).toBe(403);
    expect((await api(out, 'POST', `/events/${id}/book`, undefined, { quantity: 1 })).status).toBe(401);
    expect((await api(out, 'POST', `/events/00000000-0000-4000-8000-000000000001/book`, attendees[0]!.token, { quantity: 1 })).status).toBe(404);
    expect((await soldCount(id)).sold).toBe(0);
  });
});

describe('scenario 1: capacity 5, 50 parallel requests for 1 ticket each', () => {
  it('exactly 5 succeed, 45 get 409 SOLD_OUT, sold = 5, no duplicate tickets', async () => {
    const id = await newEvent(5, 'scenario-1');
    const { results, wallMs } = await fire(id, Array(50).fill(1));
    report('scenario 1', results, wallMs);

    expect(count(results, 201)).toBe(5);
    expect(count(results, 409)).toBe(45);
    expect(results.length).toBe(50);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.error).toBe('SOLD_OUT');

    const ev = await soldCount(id);
    expect(ev.sold).toBe(5);
    expect(ev.remaining).toBe(0);

    const ids = ticketIds(results);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);

    // what is actually stored, read back through each buyer's own "My Tickets"
    const stored = await storedTickets(id, 5);
    expect(stored).toHaveLength(5);
    expect(new Set(stored.map((t) => t.ticketId)).size).toBe(5);
    expect(new Set(stored.map((t) => t.ticketId))).toEqual(new Set(ids));
    expect(stored.every((t) => t.status === 'BOOKED')).toBe(true);

    // still sold out afterwards
    const late = await api(out, 'POST', `/events/${id}/book`, attendees[0]!.token, { quantity: 1 });
    expect(late.status).toBe(409);
    expect((await soldCount(id)).sold).toBe(5);
  }, 120_000);
});

describe('scenario 2: capacity 5, 30 parallel requests for 2 tickets each', () => {
  it('exactly 2 bookings fit (4 tickets), sold never exceeds 5, the last seat is still bookable', async () => {
    const id = await newEvent(5, 'scenario-2');
    const { results, wallMs } = await fire(id, Array(30).fill(2));
    report('scenario 2', results, wallMs);

    expect(count(results, 201)).toBe(2);
    expect(count(results, 409)).toBe(28);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.error).toBe('SOLD_OUT');

    let ev = await soldCount(id);
    expect(ev.sold).toBe(4);
    expect(ev.sold).toBeLessThanOrEqual(5);

    // one seat is left: a single-ticket booking must still succeed, a second must not
    const one = await api(out, 'POST', `/events/${id}/book`, attendees[1]!.token, { quantity: 1 });
    expect(one.status).toBe(201);
    const two = await api(out, 'POST', `/events/${id}/book`, attendees[2]!.token, { quantity: 1 });
    expect(two.status).toBe(409);

    ev = await soldCount(id);
    expect(ev.sold).toBe(5);

    const ids = [...ticketIds(results), ...one.body.tickets.map((t: any) => t.ticketId as string)];
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    const stored = await storedTickets(id, 5);
    expect(new Set(stored.map((t) => t.ticketId))).toEqual(new Set(ids));
  }, 120_000);
});

describe('scenario 3: capacity 5, 40 parallel requests with mixed quantities (1, 2, 3)', () => {
  it('sold never exceeds capacity and equals the tickets actually issued', async () => {
    const id = await newEvent(5, 'scenario-3');
    const quantities = Array.from({ length: 40 }, (_, i) => (i % 3) + 1);
    const { results, wallMs } = await fire(id, quantities);
    report('scenario 3', results, wallMs);

    // every request got a clean answer: created, or 409 sold out. Nothing else.
    expect(count(results, 201) + count(results, 409)).toBe(40);
    const issued = results.filter((r) => r.status === 201).reduce((n, r) => n + r.quantity, 0);
    expect(issued).toBeLessThanOrEqual(5);

    const ev = await soldCount(id);
    expect(ev.sold).toBe(issued);
    expect(ev.sold).toBeLessThanOrEqual(5);

    const ids = ticketIds(results);
    expect(ids).toHaveLength(issued);
    expect(new Set(ids).size).toBe(issued);
    const stored = await storedTickets(id, issued);
    expect(stored).toHaveLength(issued);
    expect(new Set(stored.map((t) => t.ticketId))).toEqual(new Set(ids));
  }, 120_000);
});
