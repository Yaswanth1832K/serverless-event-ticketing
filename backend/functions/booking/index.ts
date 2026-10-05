import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from '../../shared/db';
import { json, HttpError } from '../../shared/http';
import { getUser, requireRole } from '../../shared/auth';
import { log } from '../../shared/logger';
import { putMetric } from '../../shared/metrics';
import { parseBody, validateQuantity, eventIdFrom } from '../../shared/validation';
import type { EventItem } from '../../shared/types';

// Many buyers hitting the same event item at once cause DynamoDB TransactionConflict errors.
// Those are retried with jittered backoff. They are not a sold-out signal.
const MAX_ATTEMPTS = 12;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt: number) => Math.random() * Math.min(25 * 2 ** attempt, 400);

interface CancellationReason {
  Code?: string;
}

function cancellationCodes(err: unknown): string[] | null {
  const e = err as { name?: string; CancellationReasons?: CancellationReason[] };
  if (e?.name !== 'TransactionCanceledException') return null;
  return (e.CancellationReasons ?? []).map((r) => r.Code ?? 'None');
}

async function readEvent(eventId: string): Promise<EventItem> {
  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE(),
      Key: { PK: `EVENT#${eventId}`, SK: 'META' },
      ConsistentRead: true,
    }),
  );
  if (!res.Item) throw new HttpError(404, 'NOT_FOUND', 'Event not found');
  return res.Item as EventItem;
}

// Overselling protection. DynamoDB condition expressions cannot do arithmetic, so we read the
// capacity, compute the highest `sold` that still leaves room (capacity - quantity) and let
// DynamoDB check it atomically:
//
//   condition:  sold <= :max  AND  capacity = :cap        (:max = capacity - quantity)
//   action:     sold = sold + :quantity
//
// The read is only a hint. The condition is what guarantees correctness, because DynamoDB
// evaluates it against the current stored value. If another buyer got there first the condition
// fails and we re-read. The ticket items are written in the same transaction, so a booking is
// all-or-nothing.
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (event.httpMethod !== 'POST' || event.resource !== '/events/{id}/book') {
      throw new HttpError(404, 'NOT_FOUND', 'Route not found');
    }
    const user = getUser(event);
    requireRole(user, 'Attendee');
    const eventId = eventIdFrom(event.pathParameters);
    const quantity = validateQuantity(parseBody(event.body));

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const ev = await readEvent(eventId);

      if (Date.parse(ev.startsAt) <= Date.now()) {
        throw new HttpError(409, 'EVENT_STARTED', 'Booking is closed for this event');
      }
      const remaining = ev.capacity - ev.sold;
      if (remaining < quantity) {
        putMetric('BookingRejectedSoldOut');
        log.info('booking rejected: sold out', { eventId, quantity, remaining });
        return json(event, 409, {
          error: 'SOLD_OUT',
          message: remaining > 0 ? `Only ${remaining} ticket(s) left` : 'Sold out',
          remaining,
        });
      }

      const now = new Date().toISOString();
      const tickets = Array.from({ length: quantity }, () => {
        const ticketId = randomUUID();
        return {
          PK: `EVENT#${eventId}`,
          SK: `TICKET#${ticketId}`,
          entity: 'TICKET',
          ticketId,
          eventId,
          status: 'BOOKED',
          ownerId: user.sub,
          // Snapshot of event details so "My Tickets" needs no join.
          eventName: ev.name,
          venue: ev.venue,
          startsAt: ev.startsAt,
          priceCents: ev.priceCents,
          createdAt: now,
          GSI1PK: `USER#${user.sub}`,
          GSI1SK: `TICKET#${now}#${ticketId}`,
        };
      });

      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: TABLE(),
                  Key: { PK: `EVENT#${eventId}`, SK: 'META' },
                  UpdateExpression: 'SET #sold = #sold + :n',
                  ConditionExpression: 'attribute_exists(PK) AND #sold <= :max AND #cap = :cap',
                  ExpressionAttributeNames: { '#sold': 'sold', '#cap': 'capacity' },
                  ExpressionAttributeValues: { ':n': quantity, ':max': ev.capacity - quantity, ':cap': ev.capacity },
                },
              },
              ...tickets.map((t) => ({
                Put: { TableName: TABLE(), Item: t, ConditionExpression: 'attribute_not_exists(PK)' },
              })),
            ],
          }),
        );
      } catch (err) {
        const codes = cancellationCodes(err);
        if (!codes) throw err;
        if (codes[0] === 'ConditionalCheckFailed') continue; // someone else booked first: re-read
        if (codes.some((c) => c === 'TransactionConflict' || c === 'ThrottlingError')) {
          putMetric('BookingConflictRetry');
          await sleep(backoffMs(attempt));
          continue;
        }
        log.error('transaction cancelled', { codes });
        throw err;
      }

      putMetric('BookingSuccess');
      log.info('booking succeeded', { eventId, quantity, attempts: attempt + 1, buyerId: user.sub });
      return json(event, 201, {
        eventId,
        quantity,
        totalPriceCents: ev.priceCents * quantity,
        tickets: tickets.map((t) => ({
          ticketId: t.ticketId,
          eventId,
          status: t.status,
          createdAt: t.createdAt,
        })),
      });
    }

    log.warn('booking gave up after repeated conflicts', { eventId, quantity });
    throw new HttpError(503, 'BUSY', 'Too many simultaneous bookings, please try again');
  } catch (err) {
    if (err instanceof HttpError) {
      return json(event, err.statusCode, { error: err.code, message: err.message });
    }
    log.error('unhandled error', { error: String(err) });
    return json(event, 500, { error: 'INTERNAL', message: 'Internal server error' });
  }
}
