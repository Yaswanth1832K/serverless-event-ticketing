import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('../../backend/shared/db', () => ({
  ddb: { send: (cmd: unknown) => send(cmd) },
  TABLE: () => 'test-table',
}));

import { handler } from '../../backend/functions/analytics/index';

const EID = '22222222-2222-4222-8222-222222222222';
const cmdName = (c: unknown) => (c as { constructor?: { name?: string } } | undefined)?.constructor?.name;

const req = (resource: string, who: { sub: string; groups: string } | null, id?: string) =>
  ({
    httpMethod: 'GET', resource, pathParameters: id ? { id } : null, headers: {}, body: null,
    requestContext: { authorizer: who ? { claims: { sub: who.sub, 'cognito:groups': who.groups } } : undefined },
  }) as never;

const orgA = { sub: 'org-A', groups: 'Organizer' };
const orgB = { sub: 'org-B', groups: 'Organizer' };
const meta = { Item: { PK: `EVENT#${EID}`, SK: 'META', eventId: EID, name: 'Fest', startsAt: '2030-01-01T00:00:00.000Z', capacity: 10, sold: 8, checkedIn: 5, organizerId: 'org-A' } };

beforeEach(() => {
  send.mockReset();
});

describe('analytics access control', () => {
  for (const [label, who] of [['Attendee', { sub: 'a', groups: 'Attendee' }], ['Staff', { sub: 's', groups: 'Staff' }], ['no group', { sub: 'x', groups: '' }]] as const) {
    it(`${label} gets 403 on both endpoints and nothing is read`, async () => {
      expect((await handler(req('/events/{id}/analytics', who, EID))).statusCode).toBe(403);
      expect((await handler(req('/dashboard', who))).statusCode).toBe(403);
      expect(send).not.toHaveBeenCalled();
    });
  }
  it('anonymous gets 401', async () => {
    expect((await handler(req('/dashboard', null))).statusCode).toBe(401);
  });
  it('another organizer gets 403 on this event and no bucket query is made', async () => {
    send.mockResolvedValueOnce(meta);
    const res = await handler(req('/events/{id}/analytics', orgB, EID));
    expect(res.statusCode).toBe(403);
    expect(send.mock.calls.map(([c]) => cmdName(c))).toEqual(['GetCommand']);
    expect(res.body).not.toContain('sold');
  });
  it('unknown event gets 404 and a malformed id gets 404', async () => {
    send.mockResolvedValueOnce({});
    expect((await handler(req('/events/{id}/analytics', orgA, EID))).statusCode).toBe(404);
    expect((await handler(req('/events/{id}/analytics', orgA, 'nope'))).statusCode).toBe(404);
  });
});

describe('analytics content', () => {
  it('event analytics returns counters, attendance % and a sorted time series', async () => {
    send.mockResolvedValueOnce(meta).mockResolvedValueOnce({
      Items: [{ SK: 'CHECKIN#2026-10-05T07:31', count: 2 }, { SK: 'CHECKIN#2026-10-05T07:29', count: 3 }],
    });
    const res = await handler(req('/events/{id}/analytics', orgA, EID));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ sold: 8, remaining: 2, checkedIn: 5, attendancePct: 62.5, capacity: 10 });
    expect(body.checkInsOverTime).toEqual([
      { minute: '2026-10-05T07:29', count: 3 },
      { minute: '2026-10-05T07:31', count: 2 },
    ]);
    expect(res.body).not.toContain('org-A'); // organizer id is never returned
  });
  it('dashboard totals add up across events and the series merges minutes', async () => {
    const ev = (id: string, sold: number, checkedIn: number, capacity: number, startsAt: string) => ({ eventId: id, name: id, startsAt, capacity, sold, checkedIn });
    send
      .mockResolvedValueOnce({ Items: [ev('e1', 8, 5, 10, '2030-01-01T00:00:00Z'), ev('e2', 0, 0, 5, '2030-02-01T00:00:00Z'), ev('e3', 4, 4, 4, '2030-03-01T00:00:00Z')] })
      .mockResolvedValueOnce({ Items: [{ SK: 'CHECKIN#2026-10-05T07:29', count: 1 }] }) // e3 (newest first)
      .mockResolvedValueOnce({ Items: [{ SK: 'CHECKIN#2026-10-05T07:29', count: 2 }, { SK: 'CHECKIN#2026-10-05T07:30', count: 3 }] }); // e1
    const res = await handler(req('/dashboard', orgA));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.totals).toEqual({ totalEvents: 3, ticketsSold: 12, remaining: 7, checkedIn: 9, attendancePct: 75 });
    expect(body.events.map((e: { eventId: string }) => e.eventId)).toEqual(['e1', 'e2', 'e3']);
    expect(body.checkInsOverTime).toEqual([
      { minute: '2026-10-05T07:29', count: 3 },
      { minute: '2026-10-05T07:30', count: 3 },
    ]);
    expect(body.seriesCoversEvents).toBe(2);
  });
  it('an organizer with no events gets zeros, not an error', async () => {
    send.mockResolvedValueOnce({ Items: [] });
    const body = JSON.parse((await handler(req('/dashboard', orgA))).body);
    expect(body.totals).toEqual({ totalEvents: 0, ticketsSold: 0, remaining: 0, checkedIn: 0, attendancePct: 0 });
  });
});
