import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  loadOutputs, createUser, createStaffUser, deleteUser, api, futureDate, eventually,
  waitForRoutes, purgeEvent, readQrSecret, type Outputs, type TestUser,
} from './helpers';
import { signToken } from '../../backend/shared/qr';

// QR check-in, tested against the DEPLOYED API with real Cognito tokens.
let out: Outputs;
let realSecret: string; // held in memory only, never logged
let orgA: TestUser, orgB: TestUser, buyer: TestUser, stranger: TestUser, staff: TestUser;
let e1: string, e2: string; // two events owned by orgA
const events: string[] = [];

interface Ticket { ticketId: string; token: string }
const tickets: Ticket[] = []; // buyer's tickets for event 1

async function newEvent(label: string): Promise<string> {
  const r = await api(out, 'POST', '/events', orgA.token, {
    name: `CHECKIN-TEST ${label}`, description: 'Automated test. Safe to delete.', venue: 'Gate',
    startsAt: futureDate(30), priceCents: 0, capacity: 20,
  });
  expect(r.status, r.raw).toBe(201);
  events.push(r.body.eventId);
  return r.body.eventId;
}

const scan = (who: TestUser | undefined, token: unknown, eventId = e1) =>
  api(out, 'POST', '/checkin', who?.token, { token, eventId });

async function statusOf(ticketId: string): Promise<string> {
  const r = await eventually(
    () => api(out, 'GET', '/my/tickets', buyer.token),
    (x) => x.body.tickets.some((t: any) => t.ticketId === ticketId),
  );
  return r.body.tickets.find((t: any) => t.ticketId === ticketId).status;
}

async function qrFor(ticketId: string, eventId = e1, who = buyer) {
  return api(out, 'GET', `/events/${eventId}/tickets/${ticketId}/qr`, who.token);
}

beforeAll(async () => {
  out = loadOutputs();
  [orgA, orgB, buyer, stranger, staff] = await Promise.all([
    createUser(out, 'Organizer', 'ci-orgA'),
    createUser(out, 'Organizer', 'ci-orgB'),
    createUser(out, 'Attendee', 'ci-buyer'),
    createUser(out, 'Attendee', 'ci-stranger'),
    createStaffUser(out, 'ci-staff'),
  ]);
  realSecret = await readQrSecret();
  await waitForRoutes(out, buyer.token);
  e1 = await newEvent('event-1');
  e2 = await newEvent('event-2');

  const booked = await api(out, 'POST', `/events/${e1}/book`, buyer.token, { quantity: 5 });
  expect(booked.status, booked.raw).toBe(201);
  for (const t of booked.body.tickets) {
    const q = await qrFor(t.ticketId);
    expect(q.status, q.raw).toBe(200);
    tickets.push({ ticketId: t.ticketId, token: q.body.token });
  }
}, 180_000);

afterAll(async () => {
  for (const id of events) await purgeEvent(out, id);
  await Promise.all([orgA, orgB, buyer, stranger, staff].map((u) => deleteUser(out, u.email)));
}, 120_000);

describe('QR endpoint', () => {
  it('owner gets a signed token that carries no personal data', async () => {
    const q = await qrFor(tickets[0]!.ticketId);
    expect(q.status).toBe(200);
    expect(q.body.token).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    const payload = JSON.parse(Buffer.from(q.body.token.split('.')[1], 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['eid', 'exp', 'tid']);
    expect(q.raw).not.toContain(buyer.email);
    expect(Date.parse(q.body.expiresAt)).toBeGreaterThan(Date.now());
  });
  it('a user who does not own the ticket cannot fetch its QR (404, no token)', async () => {
    for (const who of [stranger, orgA, orgB, staff]) {
      const q = await qrFor(tickets[0]!.ticketId, e1, who);
      expect(q.status, who.email).toBe(404);
      expect(q.raw).not.toContain('"token"');
    }
  });
  it('rejects anonymous callers, wrong event ids and malformed ids', async () => {
    expect((await api(out, 'GET', `/events/${e1}/tickets/${tickets[0]!.ticketId}/qr`)).status).toBe(401);
    expect((await qrFor(tickets[0]!.ticketId, e2)).status).toBe(404);
    expect((await qrFor('not-a-uuid')).status).toBe(404);
    expect((await qrFor(randomUUID())).status).toBe(404);
  });
});

describe('forged, edited, expired and wrong-event tokens are rejected', () => {
  const tamperedCases = () => {
    const [v, p, s] = tickets[0]!.token.split('.') as [string, string, string];
    const edit = (patch: object) =>
      `${v}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), ...patch })).toString('base64url')}.${s}`;
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      'random text': 'hello-world',
      'signature stripped': `${v}.${p}.`,
      'alg none style': `none.${p}.`,
      'forged with a random key': signToken(randomBytes(48).toString('base64'), {
        tid: tickets[0]!.ticketId, eid: e1, exp: nowSec + 3600,
      }),
      'edited ticket id': edit({ tid: tickets[1]!.ticketId }),
      'edited event id': edit({ eid: e2 }),
      'edited expiry': edit({ exp: nowSec + 999_999_999 }),
      'one character flipped': tickets[0]!.token.slice(0, -2) + (tickets[0]!.token.endsWith('A') ? 'B' : 'A') + tickets[0]!.token.slice(-1),
    };
  };

  it('rejects every forged or edited token with 400 INVALID_TOKEN', async () => {
    for (const [label, token] of Object.entries(tamperedCases())) {
      const r = await scan(staff, token);
      expect(r.status, label).toBe(400);
      expect(r.body.error, label).toBe('INVALID_TOKEN');
    }
  });

  it('rejects an expired token (signed with the real key) with 400 TOKEN_EXPIRED', async () => {
    const expired = signToken(realSecret, {
      tid: tickets[0]!.ticketId, eid: e1, exp: Math.floor(Date.now() / 1000) - 60,
    });
    const r = await scan(staff, expired);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('TOKEN_EXPIRED');
  });

  it('rejects a token from another event with 409 WRONG_EVENT', async () => {
    const r = await scan(staff, tickets[0]!.token, e2);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('WRONG_EVENT');
  });

  it('rejects a validly signed token for a ticket that does not exist (404)', async () => {
    const ghost = signToken(realSecret, { tid: randomUUID(), eid: e1, exp: Math.floor(Date.now() / 1000) + 600 });
    const r = await scan(staff, ghost);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('TICKET_NOT_FOUND');
  });

  it('none of those rejected scans changed any ticket', async () => {
    for (const t of tickets) expect(await statusOf(t.ticketId)).toBe('BOOKED');
  });
});

describe('role and ownership checks on the scan endpoint', () => {
  it('an Attendee token gets 403', async () => {
    const r = await scan(buyer, tickets[0]!.token);
    expect(r.status).toBe(403);
    expect((await scan(stranger, tickets[0]!.token)).status).toBe(403);
  });
  it('anonymous gets 401', async () => {
    expect((await scan(undefined, tickets[0]!.token)).status).toBe(401);
  });
  it('an Organizer who does not own the event gets 403', async () => {
    expect((await scan(orgB, tickets[0]!.token)).status).toBe(403);
  });
  it('bad input gets 400', async () => {
    expect((await api(out, 'POST', '/checkin', staff.token, { eventId: e1 })).status).toBe(400);
    expect((await api(out, 'POST', '/checkin', staff.token, { token: 'x', eventId: 'nope' })).status).toBe(400);
    expect((await api(out, 'POST', '/checkin', staff.token, '{bad')).status).toBe(400);
  });
  it('the ticket is still BOOKED after all of that', async () => {
    expect(await statusOf(tickets[0]!.ticketId)).toBe('BOOKED');
  });
});

describe('admission', () => {
  it('first valid scan by Staff is admitted', async () => {
    const r = await scan(staff, tickets[0]!.token);
    expect(r.status, r.raw).toBe(200);
    expect(r.body.result).toBe('CHECKED_IN');
    expect(r.body.ticketId).toBe(tickets[0]!.ticketId);
    expect(await eventually(() => statusOf(tickets[0]!.ticketId), (s) => s === 'CHECKED_IN')).toBe('CHECKED_IN');
  });
  it('a duplicate scan is rejected (by Staff and by the owning Organizer)', async () => {
    const a = await scan(staff, tickets[0]!.token);
    expect(a.status).toBe(409);
    expect(a.body.error).toBe('ALREADY_USED');
    expect(a.body.checkedInAt).toBeTruthy();
    const b = await scan(orgA, tickets[0]!.token);
    expect(b.status).toBe(409);
    expect(b.body.error).toBe('ALREADY_USED');
  });
  it('the owning Organizer can admit a different ticket', async () => {
    const r = await scan(orgA, tickets[1]!.token);
    expect(r.status, r.raw).toBe(200);
  });
});

describe('20 simultaneous scans of one ticket', () => {
  it('exactly 1 succeeds, 19 get 409 ALREADY_USED, no errors', async () => {
    const ticket = tickets[2]!;
    // alternate Staff and the owning Organizer so two different identities race
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const s = Date.now();
        const r = await scan(i % 2 === 0 ? staff : orgA, ticket.token);
        return { status: r.status, error: r.body?.error as string | undefined, ms: Date.now() - s };
      }),
    );
    const hist: Record<string, number> = {};
    for (const r of results) hist[r.status] = (hist[r.status] ?? 0) + 1;
    const ms = results.map((r) => r.ms).sort((a, b) => a - b);
    console.log(
      `[parallel scan] 20 simultaneous scans of one ticket, status counts ${JSON.stringify(hist)}, ` +
        `latency p50=${ms[10]}ms max=${ms[19]}ms, wall=${Date.now() - t0}ms`,
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const dup = results.filter((r) => r.status === 409);
    expect(dup).toHaveLength(19);
    for (const r of dup) expect(r.error).toBe('ALREADY_USED');
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);

    expect(await eventually(() => statusOf(ticket.ticketId), (s) => s === 'CHECKED_IN')).toBe('CHECKED_IN');
  }, 90_000);

  it('simultaneous scans of different tickets all succeed (no false rejections)', async () => {
    const rest = tickets.slice(3);
    const results = await Promise.all(rest.map((t) => scan(staff, t.token)));
    expect(results.map((r) => r.status)).toEqual(rest.map(() => 200));
  });
});
