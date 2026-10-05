import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('../../backend/shared/db', () => ({
  ddb: { send: (cmd: unknown) => send(cmd) },
  TABLE: () => 'test-table',
  isConditionalFailure: () => false,
}));

import { handler } from '../../backend/functions/booking/index';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const cmdName = (c: unknown) => (c as { constructor?: { name?: string } } | undefined)?.constructor?.name;
const future = () => new Date(Date.now() + 86_400_000).toISOString();

const req = (who: { sub: string; groups: string } | null, body: unknown) =>
  ({
    httpMethod: 'POST',
    resource: '/events/{id}/book',
    pathParameters: { id: EVENT_ID },
    headers: {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
    requestContext: {
      authorizer: who ? { claims: { sub: who.sub, 'cognito:groups': who.groups } } : undefined,
    },
  }) as never;

const attendee = { sub: 'att-1', groups: 'Attendee' };
const eventItem = (over: Record<string, unknown> = {}) => ({
  Item: { PK: `EVENT#${EVENT_ID}`, SK: 'META', name: 'Fest', venue: 'Hall', startsAt: future(), priceCents: 100, capacity: 5, sold: 0, ...over },
});
const cancelled = (...codes: string[]) =>
  Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

beforeEach(() => {
  send.mockReset();
});

describe('booking: access and validation', () => {
  it('rejects non-attendees with 403 before touching the database', async () => {
    for (const groups of ['Organizer', 'Staff', '']) {
      const res = await handler(req({ sub: 'x', groups }, { quantity: 1 }));
      expect(res.statusCode).toBe(403);
    }
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated requests with 401', async () => {
    expect((await handler(req(null, { quantity: 1 }))).statusCode).toBe(401);
  });
  it.each([[0], [6], [1.5], ['2'], [-1], [null], [undefined]])('rejects quantity %s with 400', async (q) => {
    const res = await handler(req(attendee, { quantity: q }));
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects a missing or invalid body with 400', async () => {
    expect((await handler(req(attendee, '{bad'))).statusCode).toBe(400);
  });
  it('returns 404 for an unknown event', async () => {
    send.mockResolvedValueOnce({});
    expect((await handler(req(attendee, { quantity: 1 }))).statusCode).toBe(404);
  });
  it('refuses to book an event that already started', async () => {
    send.mockResolvedValueOnce(eventItem({ startsAt: '2020-01-01T00:00:00.000Z' }));
    expect((await handler(req(attendee, { quantity: 1 }))).statusCode).toBe(409);
  });
});

describe('booking: overselling protection logic', () => {
  it('sold out fast path returns 409 SOLD_OUT without starting a transaction', async () => {
    send.mockResolvedValueOnce(eventItem({ sold: 5 }));
    const res = await handler(req(attendee, { quantity: 1 }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('SOLD_OUT');
    expect(send.mock.calls.map(([c]) => cmdName(c))).toEqual(['GetCommand']);
  });
  it('rejects a request larger than what is left', async () => {
    send.mockResolvedValueOnce(eventItem({ sold: 4 }));
    const res = await handler(req(attendee, { quantity: 2 }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).remaining).toBe(1);
  });
  it('builds a transaction whose condition caps sold at capacity - quantity', async () => {
    send.mockResolvedValueOnce(eventItem({ sold: 1 })).mockResolvedValueOnce({});
    const res = await handler(req(attendee, { quantity: 3 }));
    expect(res.statusCode).toBe(201);
    const tx = send.mock.calls[1]![0] as { input: { TransactItems: any[] } };
    const update = tx.input.TransactItems[0].Update;
    expect(update.ConditionExpression).toContain('#sold <= :max');
    expect(update.ConditionExpression).toContain('#cap = :cap');
    expect(update.ExpressionAttributeValues).toMatchObject({ ':n': 3, ':max': 2, ':cap': 5 });
    const puts = tx.input.TransactItems.slice(1);
    expect(puts).toHaveLength(3);
    for (const p of puts) {
      expect(p.Put.ConditionExpression).toBe('attribute_not_exists(PK)');
      expect(p.Put.Item.ownerId).toBe('att-1');
      expect(p.Put.Item.status).toBe('BOOKED');
    }
    const ids = JSON.parse(res.body).tickets.map((t: { ticketId: string }) => t.ticketId);
    expect(new Set(ids).size).toBe(3);
  });
  it('re-reads and reports sold out when another buyer wins the last seat', async () => {
    send
      .mockResolvedValueOnce(eventItem({ sold: 4 })) // looks like 1 left
      .mockRejectedValueOnce(cancelled('ConditionalCheckFailed', 'None')) // lost the race
      .mockResolvedValueOnce(eventItem({ sold: 5 })); // re-read: gone
    const res = await handler(req(attendee, { quantity: 1 }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('SOLD_OUT');
  });
  it('retries transaction conflicts and then succeeds', async () => {
    send
      .mockResolvedValueOnce(eventItem())
      .mockRejectedValueOnce(cancelled('TransactionConflict', 'None'))
      .mockResolvedValueOnce(eventItem())
      .mockResolvedValueOnce({});
    const res = await handler(req(attendee, { quantity: 1 }));
    expect(res.statusCode).toBe(201);
  });
  it('gives up with 503 (not a false sold-out) if conflicts never clear', async () => {
    send.mockImplementation(async (cmd: unknown) => {
      if (cmdName(cmd) === 'GetCommand') return eventItem();
      throw cancelled('TransactionConflict', 'None');
    });
    const res = await handler(req(attendee, { quantity: 1 }));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe('BUSY');
  }, 30_000);
});
