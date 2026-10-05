import { HttpError } from './http';

export const LIMITS = {
  name: 100,
  description: 2000,
  venue: 200,
  maxPriceCents: 1_000_000,
  maxCapacity: 100_000,
  maxBodyChars: 20_000,
};

export const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface EventInput {
  name: string;
  description: string;
  venue: string;
  startsAt: string;
  priceCents: number;
  capacity: number;
  imageKey: string;
}

// Parses a JSON request body into a plain object. Throws 400 on anything else.
export function parseBody(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) throw new HttpError(400, 'VALIDATION_ERROR', 'Request body is required');
  if (raw.length > LIMITS.maxBodyChars) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Request body is too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

// Matching control characters is the whole point of these two patterns: they are used to REJECT them.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional, see above
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/; // single-line fields
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional, see above
const CONTROL_CHARS_EXCEPT_NEWLINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function text(
  body: Record<string, unknown>,
  field: 'name' | 'description' | 'venue',
  min: number,
  max: number,
  multiline: boolean,
  errors: string[],
): string | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    errors.push(`${field} must be a string`);
    return undefined;
  }
  const t = v.trim();
  if (t.length < min || t.length > max) {
    errors.push(`${field} must be ${min}-${max} characters`);
    return undefined;
  }
  if ((multiline ? CONTROL_CHARS_EXCEPT_NEWLINE : CONTROL_CHARS).test(t)) {
    errors.push(`${field} contains invalid characters`);
    return undefined;
  }
  return t;
}

function integer(
  body: Record<string, unknown>,
  field: 'priceCents' | 'capacity',
  min: number,
  max: number,
  errors: string[],
): number | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    errors.push(`${field} must be an integer between ${min} and ${max}`);
    return undefined;
  }
  return v;
}

// Validates event fields. Unknown fields (sold, organizerId, ...) are ignored, never copied.
// create: all main fields required and startsAt must be in the future.
// update: any subset is accepted but at least one field must be present.
export function validateEvent(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
  eventId: string,
): Partial<EventInput> {
  const errors: string[] = [];
  const out: Partial<EventInput> = {};

  out.name = text(body, 'name', 1, LIMITS.name, false, errors);
  out.description = text(body, 'description', 0, LIMITS.description, true, errors);
  out.venue = text(body, 'venue', 1, LIMITS.venue, false, errors);
  out.priceCents = integer(body, 'priceCents', 0, LIMITS.maxPriceCents, errors);
  out.capacity = integer(body, 'capacity', 1, LIMITS.maxCapacity, errors);

  if (body.startsAt !== undefined) {
    const ms = typeof body.startsAt === 'string' ? Date.parse(body.startsAt) : NaN;
    if (Number.isNaN(ms)) errors.push('startsAt must be a valid ISO date-time');
    else if (mode === 'create' && ms <= Date.now()) errors.push('startsAt must be in the future');
    else out.startsAt = new Date(ms).toISOString();
  }

  if (body.imageKey !== undefined) {
    const re = new RegExp(`^events/${eventId}/[0-9a-f-]{36}\\.(jpg|png|webp)$`);
    if (typeof body.imageKey !== 'string' || !re.test(body.imageKey)) {
      errors.push('imageKey is invalid for this event');
    } else {
      out.imageKey = body.imageKey;
    }
  }

  if (mode === 'create') {
    for (const f of ['name', 'venue', 'startsAt', 'priceCents', 'capacity'] as const) {
      if (body[f] === undefined) errors.push(`${f} is required`);
    }
    if (out.description === undefined) out.description = '';
  } else if (Object.values(out).every((v) => v === undefined) && errors.length === 0) {
    errors.push('No updatable fields provided');
  }

  if (errors.length) throw new HttpError(400, 'VALIDATION_ERROR', errors.join('; '));
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

export const MAX_TICKETS_PER_BOOKING = 5;

export function validateQuantity(body: Record<string, unknown>): number {
  const q = body.quantity;
  if (typeof q !== 'number' || !Number.isInteger(q) || q < 1 || q > MAX_TICKETS_PER_BOOKING) {
    throw new HttpError(400, 'VALIDATION_ERROR', `quantity must be an integer between 1 and ${MAX_TICKETS_PER_BOOKING}`);
  }
  return q;
}

export function validateCheckin(body: Record<string, unknown>): { token: string; eventId: string } {
  const { token, eventId } = body;
  if (typeof token !== 'string' || token.length < 1 || token.length > 400) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'token must be a string of 1-400 characters');
  }
  if (typeof eventId !== 'string' || !UUID_RE.test(eventId)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'eventId must be a valid event id');
  }
  return { token, eventId };
}

// Reads and validates the {id} path parameter. A malformed id is simply "not found".
export function eventIdFrom(pathParameters: Record<string, string | undefined> | null): string {
  const id = pathParameters?.id;
  if (!id || !UUID_RE.test(id)) throw new HttpError(404, 'NOT_FOUND', 'Event not found');
  return id;
}

export function validateImageRequest(body: Record<string, unknown>): {
  contentType: string;
  ext: string;
} {
  const ct = body.contentType;
  if (typeof ct !== 'string' || !(ct in IMAGE_TYPES)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'contentType must be image/jpeg, image/png or image/webp');
  }
  const size = body.sizeBytes;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_IMAGE_BYTES) {
    throw new HttpError(400, 'VALIDATION_ERROR', `sizeBytes must be an integer between 1 and ${MAX_IMAGE_BYTES}`);
  }
  return { contentType: ct, ext: IMAGE_TYPES[ct]! };
}
