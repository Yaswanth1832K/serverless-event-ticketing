import { config } from '../config';
import { ApiError, NetworkError } from '../lib/errors';
import type {
  BookingResult, CheckInResult, Dashboard, EventAnalytics, EventInput, EventSummary, ImageUploadPolicy,
  OwnedEvent, Ticket, TicketQr,
} from './types';

// The auth layer plugs itself in here so this file never imports React or Cognito.
type TokenProvider = () => Promise<string | null>;
let getToken: TokenProvider = async () => null;
let onUnauthorized: () => void = () => {};

export function setAuthHooks(hooks: { getToken: TokenProvider; onUnauthorized: () => void }): void {
  getToken = hooks.getToken;
  onUnauthorized = hooks.onUnauthorized;
}

interface Options {
  body?: unknown;
  /** 'required': send the token and treat 401 as "session ended". 'none': public route, no token. */
  auth?: 'required' | 'none';
}

export async function request<T>(method: string, path: string, opts: Options = {}): Promise<T> {
  const auth = opts.auth ?? 'required';
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth === 'required') {
    const token = await getToken();
    if (!token) {
      onUnauthorized();
      throw new ApiError(401, 'UNAUTHENTICATED', 'Not signed in');
    }
    headers.Authorization = token;
  }

  let res: Response;
  try {
    res = await fetch(`${config().apiUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new NetworkError();
  }

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const body = (data ?? {}) as { error?: string; message?: string } & Record<string, unknown>;
    // API Gateway's own 401/403 (bad or expired token) has no `error` code, only a message.
    const code = body.error ?? (res.status === 401 ? 'UNAUTHENTICATED' : `HTTP_${res.status}`);
    const { error: _e, message: _m, ...extra } = body;
    if (res.status === 401 && auth === 'required') onUnauthorized();
    throw new ApiError(res.status, code, body.message ?? res.statusText, extra);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  // public
  listEvents: () => request<{ events: EventSummary[] }>('GET', '/events', { auth: 'none' }).then((r) => r.events),
  getEvent: (id: string) => request<EventSummary>('GET', `/events/${enc(id)}`, { auth: 'none' }),

  // organizer
  myEvents: () => request<{ events: OwnedEvent[] }>('GET', '/my/events').then((r) => r.events),
  createEvent: (input: EventInput) => request<OwnedEvent>('POST', '/events', { body: input }),
  updateEvent: (id: string, patch: Partial<EventInput>) => request<OwnedEvent>('PUT', `/events/${enc(id)}`, { body: patch }),
  deleteEvent: (id: string) => request<{ deleted: boolean }>('DELETE', `/events/${enc(id)}`),
  imageUploadPolicy: (id: string, contentType: string, sizeBytes: number) =>
    request<ImageUploadPolicy>('POST', `/events/${enc(id)}/image-url`, { body: { contentType, sizeBytes } }),
  dashboard: () => request<Dashboard>('GET', '/dashboard'),
  eventAnalytics: (id: string) => request<EventAnalytics>('GET', `/events/${enc(id)}/analytics`),

  // attendee
  book: (id: string, quantity: number) => request<BookingResult>('POST', `/events/${enc(id)}/book`, { body: { quantity } }),
  myTickets: () => request<{ tickets: Ticket[] }>('GET', '/my/tickets').then((r) => r.tickets),
  ticketQr: (eventId: string, ticketId: string) =>
    request<TicketQr>('GET', `/events/${enc(eventId)}/tickets/${enc(ticketId)}/qr`),

  // staff and organizer
  checkIn: (token: string, eventId: string) => request<CheckInResult>('POST', '/checkin', { body: { token, eventId } }),
};

// The browser sends the picture straight to S3 with the short-lived signed form from the API.
// S3 itself refuses a wrong type or a file over the size limit, whatever the browser claims.
export async function uploadToS3(policy: ImageUploadPolicy, file: File): Promise<void> {
  const form = new FormData();
  for (const [k, v] of Object.entries(policy.fields)) form.append(k, v);
  form.append('file', file); // must be the last field
  let res: Response;
  try {
    res = await fetch(policy.url, { method: 'POST', body: form });
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) {
    throw new ApiError(res.status, 'UPLOAD_FAILED', 'The image upload was refused. Use a JPEG, PNG or WebP picture under 2 MB.');
  }
}
