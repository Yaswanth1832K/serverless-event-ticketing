import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from '../../shared/db';
import { json, HttpError } from '../../shared/http';
import { getUser, requireRole, type AuthUser } from '../../shared/auth';
import { log } from '../../shared/logger';
import { eventIdFrom } from '../../shared/validation';
import type { EventItem } from '../../shared/types';

// Read-only endpoints for the organizer dashboard. Counters are not computed here: `sold` is kept
// by the booking transaction and `checkedIn` plus the per-minute buckets by the stream processor.
const MAX_DASHBOARD_SERIES_EVENTS = 20; // time series is merged for at most this many events
const MAX_BUCKET_PAGES = 3; // 3 x 1 MB of buckets is days of per-minute data

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

function summarize(e: Pick<EventItem, 'eventId' | 'name' | 'startsAt' | 'capacity' | 'sold' | 'checkedIn'>) {
  const sold = e.sold ?? 0;
  const checkedIn = e.checkedIn ?? 0;
  return {
    eventId: e.eventId,
    name: e.name,
    startsAt: e.startsAt,
    capacity: e.capacity,
    sold,
    remaining: Math.max(e.capacity - sold, 0),
    checkedIn,
    attendancePct: pct(checkedIn, sold),
  };
}

async function checkInBuckets(eventId: string): Promise<{ minute: string; count: number }[]> {
  const out: { minute: string; count: number }[] = [];
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < MAX_BUCKET_PAGES; page++) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE(),
        KeyConditionExpression: 'PK = :p AND begins_with(SK, :c)',
        ExpressionAttributeValues: { ':p': `EVENT#${eventId}`, ':c': 'CHECKIN#' },
        ExpressionAttributeNames: { '#count': 'count' },
        ProjectionExpression: 'SK, #count',
        ExclusiveStartKey: start,
      }),
    );
    for (const it of res.Items ?? []) out.push({ minute: String(it.SK).slice('CHECKIN#'.length), count: Number(it.count) });
    start = res.LastEvaluatedKey;
    if (!start) break;
  }
  return out;
}

async function loadOwnedEvent(eventId: string, user: AuthUser): Promise<EventItem> {
  // Strongly consistent read: the counters shown must be the latest committed values.
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE(), Key: { PK: `EVENT#${eventId}`, SK: 'META' }, ConsistentRead: true }),
  );
  const ev = res.Item as EventItem | undefined;
  if (!ev) throw new HttpError(404, 'NOT_FOUND', 'Event not found');
  if (ev.organizerId !== user.sub) throw new HttpError(403, 'FORBIDDEN', 'You do not own this event');
  return ev;
}

// GET /events/{id}/analytics
async function eventAnalytics(e: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const user = getUser(e);
  requireRole(user, 'Organizer');
  const eventId = eventIdFrom(e.pathParameters);
  const ev = await loadOwnedEvent(eventId, user);
  const checkInsOverTime = (await checkInBuckets(eventId)).sort((a, b) => a.minute.localeCompare(b.minute));
  return json(e, 200, { ...summarize(ev), checkInsOverTime, generatedAt: new Date().toISOString() });
}

// GET /dashboard: totals and event-wise sales across the caller's own events.
async function dashboard(e: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const user = getUser(e);
  requireRole(user, 'Organizer');

  const events: EventItem[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE(),
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :u AND begins_with(GSI1SK, :e)',
        ExpressionAttributeValues: { ':u': `USER#${user.sub}`, ':e': 'EVENT#' },
        ExclusiveStartKey: start,
      }),
    );
    events.push(...(res.Items as EventItem[]));
    start = res.LastEvaluatedKey;
  } while (start && events.length < 200);

  const rows = events.map(summarize).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const sold = rows.reduce((n, r) => n + r.sold, 0);
  const checkedIn = rows.reduce((n, r) => n + r.checkedIn, 0);

  // Merge per-minute buckets of the events that have any check-ins (capped, newest events first).
  const withCheckIns = [...rows].filter((r) => r.checkedIn > 0).reverse().slice(0, MAX_DASHBOARD_SERIES_EVENTS);
  const series = new Map<string, number>();
  const lists = await Promise.all(withCheckIns.map((r) => checkInBuckets(r.eventId)));
  for (const b of lists.flat()) series.set(b.minute, (series.get(b.minute) ?? 0) + b.count);

  return json(e, 200, {
    totals: {
      totalEvents: rows.length,
      ticketsSold: sold,
      remaining: rows.reduce((n, r) => n + r.remaining, 0),
      checkedIn,
      attendancePct: pct(checkedIn, sold),
    },
    events: rows,
    checkInsOverTime: [...series.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([minute, count]) => ({ minute, count })),
    seriesCoversEvents: withCheckIns.length,
    generatedAt: new Date().toISOString(),
  });
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (event.httpMethod === 'GET' && event.resource === '/dashboard') return await dashboard(event);
    if (event.httpMethod === 'GET' && event.resource === '/events/{id}/analytics') return await eventAnalytics(event);
    throw new HttpError(404, 'NOT_FOUND', 'Route not found');
  } catch (err) {
    if (err instanceof HttpError) {
      return json(event, err.statusCode, { error: err.code, message: err.message });
    }
    log.error('unhandled error', { error: String(err) });
    return json(event, 500, { error: 'INTERNAL', message: 'Internal server error' });
  }
}
