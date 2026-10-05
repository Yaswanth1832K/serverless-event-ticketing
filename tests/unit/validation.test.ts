import { describe, it, expect } from 'vitest';
import {
  parseBody,
  validateEvent,
  validateImageRequest,
  MAX_IMAGE_BYTES,
} from '../../backend/shared/validation';

const ID = '11111111-1111-4111-8111-111111111111';
const future = () => new Date(Date.now() + 86_400_000).toISOString();
const valid = () => ({
  name: ' Tech Fest ',
  description: 'Line one\nLine two',
  venue: 'Main Hall',
  startsAt: future(),
  priceCents: 500,
  capacity: 100,
});

describe('parseBody', () => {
  it('rejects empty, invalid JSON, arrays and oversized bodies', () => {
    expect(() => parseBody(null)).toThrow(/required/);
    expect(() => parseBody('{nope')).toThrow(/valid JSON/);
    expect(() => parseBody('[1]')).toThrow(/object/);
    expect(() => parseBody('{"a":"' + 'x'.repeat(25_000) + '"}')).toThrow(/too large/);
  });
  it('accepts an object', () => expect(parseBody('{"a":1}')).toEqual({ a: 1 }));
});

describe('validateEvent create', () => {
  it('accepts a valid event and trims strings', () => {
    const out = validateEvent(valid(), 'create', ID);
    expect(out.name).toBe('Tech Fest');
    expect(out.capacity).toBe(100);
  });
  it('requires the main fields', () => {
    expect(() => validateEvent({}, 'create', ID)).toThrow(/name is required/);
  });
  it.each([
    ['capacity 0', { capacity: 0 }],
    ['negative capacity', { capacity: -5 }],
    ['fractional capacity', { capacity: 2.5 }],
    ['string capacity', { capacity: '10' }],
    ['huge capacity', { capacity: 1_000_000 }],
    ['negative price', { priceCents: -1 }],
    ['fractional price', { priceCents: 9.99 }],
    ['empty name', { name: '   ' }],
    ['long name', { name: 'x'.repeat(101) }],
    ['control chars in name', { name: 'bad\u0000name' }],
    ['long description', { description: 'x'.repeat(2001) }],
    ['past date', { startsAt: '2020-01-01T00:00:00Z' }],
    ['bad date', { startsAt: 'tomorrow-ish' }],
    ['number date', { startsAt: 12345 }],
  ])('rejects %s', (_label, patch) => {
    expect(() => validateEvent({ ...valid(), ...patch }, 'create', ID)).toThrow(/./);
  });
  it('never copies server-owned fields', () => {
    const out = validateEvent(
      { ...valid(), sold: 0, organizerId: 'attacker', checkedIn: 99, PK: 'x' },
      'create',
      ID,
    );
    expect(out).not.toHaveProperty('sold');
    expect(out).not.toHaveProperty('organizerId');
    expect(out).not.toHaveProperty('checkedIn');
    expect(out).not.toHaveProperty('PK');
  });
});

describe('validateEvent update', () => {
  it('accepts a partial update', () => {
    expect(validateEvent({ venue: 'Room 2' }, 'update', ID)).toEqual({ venue: 'Room 2' });
  });
  it('rejects an empty update', () => {
    expect(() => validateEvent({ sold: 5 }, 'update', ID)).toThrow(/No updatable/);
  });
  it('only accepts an imageKey under this event prefix', () => {
    const good = `events/${ID}/22222222-2222-4222-8222-222222222222.png`;
    expect(validateEvent({ imageKey: good }, 'update', ID).imageKey).toBe(good);
    const other = 'events/99999999-9999-4999-8999-999999999999/22222222-2222-4222-8222-222222222222.png';
    expect(() => validateEvent({ imageKey: other }, 'update', ID)).toThrow(/imageKey/);
    expect(() => validateEvent({ imageKey: '../etc/passwd' }, 'update', ID)).toThrow(/imageKey/);
  });
});

describe('validateImageRequest', () => {
  it('accepts jpeg, png and webp within the size limit', () => {
    for (const [ct, ext] of [['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']]) {
      expect(validateImageRequest({ contentType: ct, sizeBytes: 1000 })).toEqual({ contentType: ct, ext });
    }
  });
  it('rejects other types and bad sizes', () => {
    expect(() => validateImageRequest({ contentType: 'image/gif', sizeBytes: 1000 })).toThrow(/contentType/);
    expect(() => validateImageRequest({ contentType: 'text/html', sizeBytes: 1000 })).toThrow(/contentType/);
    expect(() => validateImageRequest({ contentType: 'image/png', sizeBytes: 0 })).toThrow(/sizeBytes/);
    expect(() => validateImageRequest({ contentType: 'image/png', sizeBytes: MAX_IMAGE_BYTES + 1 })).toThrow(/sizeBytes/);
  });
});
