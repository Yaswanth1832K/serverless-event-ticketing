import { describe, it, expect, vi, beforeEach } from 'vitest';

// The database is mocked so these tests prove the authorization logic runs BEFORE any write.
const send = vi.fn();
vi.mock('../../backend/shared/db', () => ({
  ddb: { send: (cmd: unknown) => send(cmd) },
  TABLE: () => 'test-table',
  isConditionalFailure: (e: { name?: string }) => e?.name === 'ConditionalCheckFailedException',
}));

import { handler } from '../../backend/functions/events/index';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const cmdName = (c: unknown) => (c as { constructor: { name: string } }).constructor.name;
const future = () => new Date(Date.now() + 86_400_000).toISOString();

function req(
  method: string,
  resource: string,
  who: { sub: string; groups: string } | null,
  body?: unknown,
) {
  return {
    httpMethod: method,
    resource,
    pathParameters: resource.includes('{id}') ? { id: EVENT_ID } : null,
    headers: {},
    body: body === undefined ? null : JSON.stringify(body),
    requestContext: {
      authorizer: who ? { claims: { sub: who.sub, email: 'x@y.z', 'cognito:groups': who.groups } } : undefined,
    },
  } as never;
}

const attendee = { sub: 'attendee-1', groups: 'Attendee' };
const staff = { sub: 'staff-1', groups: 'Staff' };
const orgA = { sub: 'org-A', groups: 'Organizer' };
const orgB = { sub: 'org-B', groups: 'Organizer' };
const validBody = { name: 'N', venue: 'V', startsAt: future(), priceCents: 0, capacity: 10 };

const eventOwnedByA = {
  Item: { PK: `EVENT#${EVENT_ID}`, SK: 'META', eventId: EVENT_ID, organizerId: 'org-A', capacity: 10, sold: 0, checkedIn: 0 },
};

beforeEach(() => {
  send.mockReset();
});

describe('role checks: Attendee and Staff get 403 and never touch the database', () => {
  const cases: [string, string, string, unknown][] = [
    ['create', 'POST', '/events', validBody],
    ['edit', 'PUT', '/events/{id}', { name: 'Hacked' }],
    ['delete', 'DELETE', '/events/{id}', undefined],
    ['image-url', 'POST', '/events/{id}/image-url', { contentType: 'image/png', sizeBytes: 10 }],
    ['my events', 'GET', '/my/events', undefined],
  ];
  for (const [label, method, resource, body] of cases) {
    for (const [roleName, who] of [['Attendee', attendee], ['Staff', staff]] as const) {
      it(`${roleName} ${label} -> 403`, async () => {
        const res = await handler(req(method, resource, who, body));
        expect(res.statusCode).toBe(403);
        expect(send).not.toHaveBeenCalled();
      });
    }
  }
});

describe('ownership: organizer B cannot modify organizer A event', () => {
  beforeEach(() => send.mockResolvedValue(eventOwnedByA));

  it('B edit -> 403 and no UpdateCommand sent', async () => {
    const res = await handler(req('PUT', '/events/{id}', orgB, { name: 'Hijacked' }));
    expect(res.statusCode).toBe(403);
    expect(send.mock.calls.map(([c]) => cmdName(c))).toEqual(['GetCommand']);
  });
  it('B delete -> 403 and no DeleteCommand sent', async () => {
    const res = await handler(req('DELETE', '/events/{id}', orgB));
    expect(res.statusCode).toBe(403);
    expect(send.mock.calls.map(([c]) => cmdName(c))).toEqual(['GetCommand']);
  });
  it('B image upload url -> 403', async () => {
    const res = await handler(req('POST', '/events/{id}/image-url', orgB, { contentType: 'image/png', sizeBytes: 10 }));
    expect(res.statusCode).toBe(403);
  });
  it('A edit passes the ownership check and reaches UpdateCommand', async () => {
    send.mockReset();
    send
      .mockResolvedValueOnce(eventOwnedByA)
      .mockResolvedValueOnce({ Attributes: { ...eventOwnedByA.Item, name: 'Renamed', updatedAt: 'now' } });
    const res = await handler(req('PUT', '/events/{id}', orgA, { name: 'Renamed' }));
    expect(res.statusCode).toBe(200);
    const update = send.mock.calls[1]![0] as { input: { ConditionExpression: string; ExpressionAttributeValues: Record<string, unknown> } };
    expect(update.input.ConditionExpression).toContain('#org = :me');
    expect(update.input.ExpressionAttributeValues[':me']).toBe('org-A');
  });
});

describe('other behaviour', () => {
  it('unauthenticated create -> 401 (no claims)', async () => {
    const res = await handler(req('POST', '/events', null, validBody));
    expect(res.statusCode).toBe(401);
  });
  it('invalid event id -> 404 before any database call', async () => {
    const r = req('GET', '/events/{id}', null) as { pathParameters: { id: string } };
    r.pathParameters = { id: 'not-a-uuid' };
    const res = await handler(r as never);
    expect(res.statusCode).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });
  it('organizer create stores the caller as owner and ignores a forged organizerId', async () => {
    send.mockResolvedValue({});
    const res = await handler(req('POST', '/events', orgA, { ...validBody, organizerId: 'attacker', sold: 5 }));
    expect(res.statusCode).toBe(201);
    const put = send.mock.calls[0]![0] as { input: { Item: { organizerId: string; sold: number } } };
    expect(put.input.Item.organizerId).toBe('org-A');
    expect(put.input.Item.sold).toBe(0);
  });
  it('delete with sold tickets -> 409', async () => {
    send
      .mockResolvedValueOnce(eventOwnedByA)
      .mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }));
    const res = await handler(req('DELETE', '/events/{id}', orgA));
    expect(res.statusCode).toBe(409);
  });
  it('public view hides organizerId', async () => {
    send.mockResolvedValue(eventOwnedByA);
    const res = await handler(req('GET', '/events/{id}', null));
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('org-A');
    expect(res.body).not.toContain('organizerId');
  });
});
