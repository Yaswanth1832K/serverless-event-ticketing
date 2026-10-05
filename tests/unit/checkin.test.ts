import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('../../backend/shared/db', () => ({
  ddb: { send: (cmd: unknown) => send(cmd) },
  TABLE: () => 'test-table',
  isConditionalFailure: (e: { name?: string }) => e?.name === 'ConditionalCheckFailedException',
}));
const SECRET = 'unit-test-secret-unit-test-secret-0123456789';
vi.mock('../../backend/shared/secret', () => ({ getQrSecret: async () => SECRET }));

import { handler as checkin } from '../../backend/functions/checkin/index';
import { handler as tickets } from '../../backend/functions/tickets/index';
import { signToken } from '../../backend/shared/qr';

const EID = '22222222-2222-4222-8222-222222222222';
const OTHER_EID = '44444444-4444-4444-8444-444444444444';
const TID = '11111111-1111-4111-8111-111111111111';
const cmdName = (c: unknown) => (c as { constructor?: { name?: string } } | undefined)?.constructor?.name;
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const token = (over: Record<string, unknown> = {}) => signToken(SECRET, { tid: TID, eid: EID, exp: exp(), ...over } as never);

const staff = { sub: 'staff-1', groups: 'Staff' };
const orgA = { sub: 'org-A', groups: 'Organizer' };
const orgB = { sub: 'org-B', groups: 'Organizer' };
const attendee = { sub: 'att-1', groups: 'Attendee' };

const claims = (who: { sub: string; groups: string } | null) => ({
  authorizer: who ? { claims: { sub: who.sub, 'cognito:groups': who.groups } } : undefined,
});
const scan = (who: { sub: string; groups: string } | null, body: unknown) =>
  ({ httpMethod: 'POST', resource: '/checkin', pathParameters: null, headers: {}, body: JSON.stringify(body), requestContext: claims(who) }) as never;
const qr = (who: { sub: string; groups: string } | null, ticketId = TID) =>
  ({ httpMethod: 'GET', resource: '/events/{id}/tickets/{ticketId}/qr', pathParameters: { id: EID, ticketId }, headers: {}, body: null, requestContext: claims(who) }) as never;

const conditionFailed = () => Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' });
const eventOwnedByA = { Item: { PK: `EVENT#${EID}`, SK: 'META', organizerId: 'org-A', startsAt: new Date(Date.now() + 86_400_000).toISOString() } };

beforeEach(() => {
  send.mockReset();
});

describe('check-in access control', () => {
  it('Attendee gets 403 and never touches the database', async () => {
    const res = await checkin(scan(attendee, { token: token(), eventId: EID }));
    expect(res.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
  it('anonymous gets 401', async () => {
    expect((await checkin(scan(null, { token: token(), eventId: EID }))).statusCode).toBe(401);
  });
  it('Organizer who does not own the event gets 403 and no UpdateCommand is sent', async () => {
    send.mockResolvedValueOnce(eventOwnedByA);
    const res = await checkin(scan(orgB, { token: token(), eventId: EID }));
    expect(res.statusCode).toBe(403);
    expect(send.mock.calls.map(([c]) => cmdName(c))).toEqual(['GetCommand']);
  });
  it('rejects bad input with 400', async () => {
    expect((await checkin(scan(staff, { eventId: EID }))).statusCode).toBe(400);
    expect((await checkin(scan(staff, { token: 't', eventId: 'nope' }))).statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('check-in token handling', () => {
  it('rejects a forged token before any database call', async () => {
    const forged = signToken('some-other-secret-some-other-secret-1234567', { tid: TID, eid: EID, exp: exp() });
    const res = await checkin(scan(staff, { token: forged, eventId: EID }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('INVALID_TOKEN');
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects an expired token with TOKEN_EXPIRED', async () => {
    const res = await checkin(scan(staff, { token: token({ exp: 1000 }), eventId: EID }));
    expect(JSON.parse(res.body).error).toBe('TOKEN_EXPIRED');
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects a token from another event with 409 WRONG_EVENT', async () => {
    const res = await checkin(scan(staff, { token: token(), eventId: OTHER_EID }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('WRONG_EVENT');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('check-in state change', () => {
  it('first valid scan by Staff is admitted via a conditional update', async () => {
    send.mockResolvedValueOnce({ Attributes: { eventName: 'Fest' } });
    const res = await checkin(scan(staff, { token: token(), eventId: EID }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).result).toBe('CHECKED_IN');
    const upd = send.mock.calls[0]![0] as { input: { ConditionExpression: string; ExpressionAttributeValues: Record<string, string> } };
    expect(upd.input.ConditionExpression).toContain('#status = :booked');
    expect(upd.input.ExpressionAttributeValues[':booked']).toBe('BOOKED');
  });
  it('owner Organizer is admitted after the ownership lookup', async () => {
    send.mockResolvedValueOnce(eventOwnedByA).mockResolvedValueOnce({ Attributes: { eventName: 'Fest' } });
    const res = await checkin(scan(orgA, { token: token(), eventId: EID }));
    expect(res.statusCode).toBe(200);
    expect(send.mock.calls.map(([c]) => cmdName(c))).toEqual(['GetCommand', 'UpdateCommand']);
  });
  it('a duplicate scan gets 409 ALREADY_USED with the original time', async () => {
    send
      .mockRejectedValueOnce(conditionFailed())
      .mockResolvedValueOnce({ Item: { status: 'CHECKED_IN', checkedInAt: '2026-01-01T10:00:00.000Z' } });
    const res = await checkin(scan(staff, { token: token(), eventId: EID }));
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('ALREADY_USED');
    expect(body.checkedInAt).toBe('2026-01-01T10:00:00.000Z');
  });
  it('a validly signed token for a ticket that does not exist gets 404', async () => {
    send.mockRejectedValueOnce(conditionFailed()).mockResolvedValueOnce({});
    const res = await checkin(scan(staff, { token: token(), eventId: EID }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('TICKET_NOT_FOUND');
  });
  it('unexpected database errors surface as 500, not as a fake success or rejection', async () => {
    send.mockRejectedValueOnce(new Error('boom'));
    expect((await checkin(scan(staff, { token: token(), eventId: EID }))).statusCode).toBe(500);
  });
});

describe('QR endpoint ownership', () => {
  const ticketOf = (ownerId: string) => ({ Item: { ticketId: TID, eventId: EID, ownerId, status: 'BOOKED', eventName: 'Fest', venue: 'V', startsAt: new Date(Date.now() + 86_400_000).toISOString() } });

  it('owner receives a token whose payload has no personal data', async () => {
    send.mockResolvedValueOnce(ticketOf('att-1')).mockResolvedValueOnce(eventOwnedByA);
    const res = await tickets(qr(attendee));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const payload = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['eid', 'exp', 'tid']);
    expect(res.body).not.toContain('att-1');
  });
  it('a user who does not own the ticket gets 404 and no token', async () => {
    send.mockResolvedValueOnce(ticketOf('att-1'));
    const res = await tickets(qr({ sub: 'someone-else', groups: 'Attendee' }));
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('token');
  });
  it('an unknown ticket gets the same 404', async () => {
    send.mockResolvedValueOnce({});
    expect((await tickets(qr(attendee))).statusCode).toBe(404);
  });
  it('refuses to issue a QR after the event window has closed', async () => {
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
    send.mockResolvedValueOnce(ticketOf('att-1')).mockResolvedValueOnce({ Item: { startsAt: past } });
    expect((await tickets(qr(attendee))).statusCode).toBe(409);
  });
  it('anonymous gets 401', async () => {
    expect((await tickets(qr(null))).statusCode).toBe(401);
  });
});
