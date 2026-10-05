import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  loadOutputs, createUser, signUp, deleteUser, api, futureDate, eventually, waitForRoutes,
  type Outputs, type TestUser,
} from './helpers';

// Runs against the DEPLOYED stack with real Cognito tokens. See docs/05-testing.md.
let out: Outputs;
let orgA: TestUser, orgB: TestUser, attendee: TestUser;
let eventId: string;
const createdEvents: string[] = [];

const eventBody = () => ({
  name: 'Integration Fest',
  description: 'Created by an automated test',
  venue: 'Test Hall',
  startsAt: futureDate(),
  priceCents: 250,
  capacity: 5,
});

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  out = loadOutputs();
  [orgA, orgB, attendee] = await Promise.all([
    createUser(out, 'Organizer', 'orgA'),
    createUser(out, 'Organizer', 'orgB'),
    createUser(out, 'Attendee', 'att'),
  ]);
  await waitForRoutes(out, attendee.token);
  const res = await api(out, 'POST', '/events', orgA.token, eventBody());
  expect(res.status, `setup create failed: ${res.raw}`).toBe(201);
  eventId = res.body.eventId;
  createdEvents.push(eventId);
});

afterAll(async () => {
  for (const id of createdEvents) await api(out, 'DELETE', `/events/${id}`, orgA.token);
  await Promise.all([orgA, orgB, attendee].map((u) => deleteUser(out, u.email)));
});

describe('signup role mapping (against real Cognito)', () => {
  it('rejects Staff and Admin at signup', async () => {
    await expect(signUp(out, 'Staff', 'staff')).rejects.toThrow();
    await expect(signUp(out, 'Admin', 'admin')).rejects.toThrow();
  });
  it('puts Organizer and default signups in the right groups', async () => {
    const o = await api(out, 'GET', '/me', orgA.token);
    expect(o.body.groups).toEqual(['Organizer']);
    const a = await api(out, 'GET', '/me', attendee.token);
    expect(a.body.groups).toEqual(['Attendee']);
    const none = await createUser(out, undefined, 'norole');
    const n = await api(out, 'GET', '/me', none.token);
    expect(n.body.groups).toEqual(['Attendee']);
    await deleteUser(out, none.email);
  });
});

describe('authentication', () => {
  it('public browsing works without a token', async () => {
    expect((await api(out, 'GET', '/events')).status).toBe(200);
    expect((await api(out, 'GET', `/events/${eventId}`)).status).toBe(200);
  });
  it('write routes reject missing or bad tokens with 401', async () => {
    expect((await api(out, 'POST', '/events', undefined, eventBody())).status).toBe(401);
    expect((await api(out, 'PUT', `/events/${eventId}`, 'garbage', { name: 'x' })).status).toBe(401);
    expect((await api(out, 'DELETE', `/events/${eventId}`)).status).toBe(401);
  });
});

describe('attendee token gets 403 on organizer actions', () => {
  it('create -> 403', async () => {
    expect((await api(out, 'POST', '/events', attendee.token, eventBody())).status).toBe(403);
  });
  it('edit -> 403 and event is unchanged', async () => {
    expect((await api(out, 'PUT', `/events/${eventId}`, attendee.token, { name: 'Hacked' })).status).toBe(403);
    expect((await api(out, 'GET', `/events/${eventId}`)).body.name).toBe('Integration Fest');
  });
  it('delete -> 403 and event still exists', async () => {
    expect((await api(out, 'DELETE', `/events/${eventId}`, attendee.token)).status).toBe(403);
    expect((await api(out, 'GET', `/events/${eventId}`)).status).toBe(200);
  });
  it('image-url and my/events -> 403', async () => {
    const body = { contentType: 'image/png', sizeBytes: 100 };
    expect((await api(out, 'POST', `/events/${eventId}/image-url`, attendee.token, body)).status).toBe(403);
    expect((await api(out, 'GET', '/my/events', attendee.token)).status).toBe(403);
  });
});

describe('organizer B cannot touch organizer A event', () => {
  it('edit -> 403', async () => {
    const r = await api(out, 'PUT', `/events/${eventId}`, orgB.token, { name: 'Hijacked', capacity: 1 });
    expect(r.status).toBe(403);
  });
  it('delete -> 403', async () => {
    expect((await api(out, 'DELETE', `/events/${eventId}`, orgB.token)).status).toBe(403);
  });
  it('image upload url -> 403', async () => {
    const r = await api(out, 'POST', `/events/${eventId}/image-url`, orgB.token, { contentType: 'image/png', sizeBytes: 100 });
    expect(r.status).toBe(403);
  });
  it('A event is unchanged after all attempts', async () => {
    const r = await api(out, 'GET', `/events/${eventId}`);
    expect(r.body.name).toBe('Integration Fest');
    expect(r.body.capacity).toBe(5);
  });
  it("B's my/events does not list A's event, A's does", async () => {
    const b = await api(out, 'GET', '/my/events', orgB.token);
    expect(b.body.events.some((e: any) => e.eventId === eventId)).toBe(false);
    const a = await eventually(
      () => api(out, 'GET', '/my/events', orgA.token),
      (r) => r.body.events.some((e: any) => e.eventId === eventId),
    );
    expect(a.body.events.some((e: any) => e.eventId === eventId)).toBe(true);
  });
});

describe('input validation', () => {
  const bad: [string, unknown][] = [
    ['missing fields', {}],
    ['zero capacity', { ...eventBody(), capacity: 0 }],
    ['negative price', { ...eventBody(), priceCents: -1 }],
    ['past date', { ...eventBody(), startsAt: '2020-01-01T00:00:00Z' }],
    ['huge name', { ...eventBody(), name: 'x'.repeat(500) }],
    ['string capacity', { ...eventBody(), capacity: '5' }],
    ['not json', '{oops'],
  ];
  for (const [label, body] of bad) {
    it(`create with ${label} -> 400`, async () => {
      expect((await api(out, 'POST', '/events', orgA.token, body)).status).toBe(400);
    });
  }
  it('forged organizerId and sold are ignored on create', async () => {
    const r = await api(out, 'POST', '/events', orgA.token, { ...eventBody(), organizerId: 'attacker', sold: 3 });
    expect(r.status).toBe(201);
    createdEvents.push(r.body.eventId);
    expect(r.body.sold).toBe(0);
    const mine = await eventually(
      () => api(out, 'GET', '/my/events', orgA.token),
      (x) => x.body.events.some((e: any) => e.eventId === r.body.eventId),
    );
    expect(mine.body.events.some((e: any) => e.eventId === r.body.eventId)).toBe(true);
  });
  it('malformed event id -> 404', async () => {
    expect((await api(out, 'GET', '/events/not-a-uuid')).status).toBe(404);
  });
});

describe('owner can update; public view hides organizerId', () => {
  it('updates fields and keeps sold untouched', async () => {
    const r = await api(out, 'PUT', `/events/${eventId}`, orgA.token, { name: 'Renamed Fest', capacity: 8, sold: 99 });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Renamed Fest');
    expect(r.body.capacity).toBe(8);
    expect(r.body.sold).toBe(0);
  });
  it('public GET has no organizerId', async () => {
    const r = await api(out, 'GET', `/events/${eventId}`);
    expect(r.raw).not.toContain('organizerId');
    expect(r.body.remaining).toBe(8);
  });
});

describe('image upload (pre-signed POST, private bucket, CloudFront)', () => {
  const upload = async (url: string, fields: Record<string, string>, data: Buffer, overrides: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ ...fields, ...overrides })) form.append(k, v);
    form.append('file', new Blob([new Uint8Array(data)]), 'x');
    return fetch(url, { method: 'POST', body: form });
  };

  it('rejects disallowed content types and oversized declarations', async () => {
    for (const body of [
      { contentType: 'image/gif', sizeBytes: 100 },
      { contentType: 'text/html', sizeBytes: 100 },
      { contentType: 'image/png', sizeBytes: 3 * 1024 * 1024 },
      { contentType: 'image/png', sizeBytes: 0 },
    ]) {
      expect((await api(out, 'POST', `/events/${eventId}/image-url`, orgA.token, body)).status).toBe(400);
    }
  });

  it('issues a short-lived signed policy and S3 enforces it', async () => {
    const r = await api(out, 'POST', `/events/${eventId}/image-url`, orgA.token, { contentType: 'image/png', sizeBytes: PNG.length });
    expect(r.status).toBe(200);
    expect(r.body.expiresInSeconds).toBeLessThanOrEqual(300);
    const policy = JSON.parse(Buffer.from(r.body.fields.Policy, 'base64').toString());
    const ttl = (Date.parse(policy.expiration) - Date.now()) / 1000;
    expect(ttl).toBeLessThanOrEqual(130);
    expect(JSON.stringify(policy.conditions)).toContain('content-length-range');

    // wrong content type is refused by S3
    const wrongType = await upload(r.body.url, r.body.fields, PNG, { 'Content-Type': 'image/gif' });
    expect(wrongType.status).toBe(403);
    // oversized file is refused by S3
    const tooBig = await upload(r.body.url, r.body.fields, Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(tooBig.status).toBe(400);
    // the valid upload succeeds
    const ok = await upload(r.body.url, r.body.fields, PNG);
    expect(ok.status).toBe(204);

    // the imageKey must belong to this event
    const foreign = await api(out, 'PUT', `/events/${eventId}`, orgA.token, {
      imageKey: 'events/99999999-9999-4999-8999-999999999999/22222222-2222-4222-8222-222222222222.png',
    });
    expect(foreign.status).toBe(400);

    const set = await api(out, 'PUT', `/events/${eventId}`, orgA.token, { imageKey: r.body.imageKey });
    expect(set.status).toBe(200);
    expect(set.body.imageUrl).toBe(`${out.imagesBaseUrl}/${r.body.imageKey}`);

    // served through CloudFront over HTTPS
    const cf = await eventually(() => fetch(set.body.imageUrl), (x) => x.status === 200, 12, 4000);
    expect(cf.status).toBe(200);
    expect(cf.headers.get('content-type')).toBe('image/png');
    // the bucket itself is private
    const direct = await fetch(`https://${out.imagesBucket}.s3.us-east-1.amazonaws.com/${r.body.imageKey}`);
    expect(direct.status).toBe(403);
    // plain HTTP is redirected to HTTPS by CloudFront
    const http = await fetch(set.body.imageUrl.replace('https://', 'http://'), { redirect: 'manual' });
    expect([301, 302, 307, 308]).toContain(http.status);
  }, 90_000);
});

describe('delete', () => {
  it('owner deletes an unsold event, then it is gone', async () => {
    const r = await api(out, 'DELETE', `/events/${eventId}`, orgA.token);
    expect(r.status).toBe(200);
    expect((await api(out, 'GET', `/events/${eventId}`)).status).toBe(404);
    createdEvents.splice(createdEvents.indexOf(eventId), 1);
  });
});
