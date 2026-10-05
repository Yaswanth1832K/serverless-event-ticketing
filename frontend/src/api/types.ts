// Shapes of the API responses (see docs/04-api.md and the Lambda handlers).

export type Role = 'Organizer' | 'Attendee' | 'Staff';

export interface EventSummary {
  eventId: string;
  name: string;
  description: string;
  venue: string;
  startsAt: string;
  priceCents: number;
  capacity: number;
  sold: number;
  remaining: number;
  imageUrl: string | null;
  createdAt: string;
}

export interface OwnedEvent extends EventSummary {
  checkedIn: number;
  imageKey: string | null;
  updatedAt: string;
}

export interface EventInput {
  name: string;
  description: string;
  venue: string;
  startsAt: string;
  priceCents: number;
  capacity: number;
  imageKey?: string;
}

export interface Ticket {
  ticketId: string;
  eventId: string;
  status: 'BOOKED' | 'CHECKED_IN';
  eventName: string;
  venue: string;
  startsAt: string;
  priceCents: number;
  createdAt: string;
  checkedInAt: string | null;
}

export interface BookingResult {
  eventId: string;
  quantity: number;
  totalPriceCents: number;
  tickets: { ticketId: string; eventId: string; status: string; createdAt: string }[];
}

export interface TicketQr {
  ticketId: string;
  eventId: string;
  status: 'BOOKED' | 'CHECKED_IN';
  eventName: string;
  venue: string;
  startsAt: string;
  token: string;
  expiresAt: string;
}

export interface ImageUploadPolicy {
  url: string;
  fields: Record<string, string>;
  imageKey: string;
  maxBytes: number;
  expiresInSeconds: number;
}

export interface EventStats {
  eventId: string;
  name: string;
  startsAt: string;
  capacity: number;
  sold: number;
  remaining: number;
  checkedIn: number;
  attendancePct: number;
}

export interface SeriesPoint {
  minute: string; // 2026-10-05T07:29 (UTC, minute precision)
  count: number;
}

export interface EventAnalytics extends EventStats {
  checkInsOverTime: SeriesPoint[];
  generatedAt: string;
}

export interface Dashboard {
  totals: { totalEvents: number; ticketsSold: number; remaining: number; checkedIn: number; attendancePct: number };
  events: EventStats[];
  checkInsOverTime: SeriesPoint[];
  seriesCoversEvents: number;
  generatedAt: string;
}

export interface CheckInResult {
  result: 'CHECKED_IN';
  ticketId: string;
  eventId: string;
  eventName: string | null;
  checkedInAt: string;
}
