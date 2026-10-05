import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, isConditionalFailure } from '../../shared/db';
import { json, HttpError } from '../../shared/http';
import { getUser, requireRole } from '../../shared/auth';
import { log } from '../../shared/logger';
import { putMetric } from '../../shared/metrics';
import { parseBody, validateCheckin } from '../../shared/validation';
import { verifyToken, QrError, type QrPayload } from '../../shared/qr';
import { getQrSecret } from '../../shared/secret';
import type { EventItem } from '../../shared/types';

function reject(reason: string, status: number, code: string, message: string, extra: Record<string, unknown> = {}): never {
  putMetric('CheckInRejected');
  // The token itself is never logged.
  log.warn('check-in rejected', { reason });
  throw new HttpError(status, code, message, extra);
}

// POST /checkin  { token, eventId }
// eventId is the event the scanner is working on. A ticket for any other event is refused.
//
// Order of checks: role -> input -> token signature and expiry -> token/event match ->
// organizer owns the event -> atomic conditional update.
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (event.httpMethod !== 'POST' || event.resource !== '/checkin') {
      throw new HttpError(404, 'NOT_FOUND', 'Route not found');
    }
    const user = getUser(event);
    requireRole(user, 'Organizer', 'Staff');
    const { token, eventId } = validateCheckin(parseBody(event.body));

    let payload: QrPayload;
    try {
      payload = verifyToken(await getQrSecret(), token);
    } catch (err) {
      if (err instanceof QrError) {
        if (err.code === 'EXPIRED') reject('expired', 400, 'TOKEN_EXPIRED', 'This QR code has expired');
        reject('bad-token', 400, 'INVALID_TOKEN', 'This QR code is not valid');
      }
      throw err;
    }

    if (payload.eid !== eventId) {
      reject('wrong-event', 409, 'WRONG_EVENT', 'This ticket is for a different event');
    }

    // Organizers may only scan for events they own. Staff are not tied to one organizer (see
    // docs/limitations.md), so for Staff we skip this lookup.
    if (!user.groups.includes('Staff')) {
      const ev = await ddb.send(
        new GetCommand({ TableName: TABLE(), Key: { PK: `EVENT#${eventId}`, SK: 'META' } }),
      );
      if (!ev.Item) reject('unknown-event', 404, 'NOT_FOUND', 'Event not found');
      if ((ev.Item as EventItem).organizerId !== user.sub) {
        reject('not-event-owner', 403, 'FORBIDDEN', 'You do not own this event');
      }
    }

    const key = { PK: `EVENT#${payload.eid}`, SK: `TICKET#${payload.tid}` };
    const now = new Date().toISOString();
    try {
      // The only thing that admits a ticket. DynamoDB evaluates the condition atomically, so of
      // any number of simultaneous scans exactly one can move BOOKED to CHECKED_IN.
      const res = await ddb.send(
        new UpdateCommand({
          TableName: TABLE(),
          Key: key,
          UpdateExpression: 'SET #status = :checked, checkedInAt = :now, checkedInBy = :by',
          ConditionExpression: 'attribute_exists(PK) AND #status = :booked',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':checked': 'CHECKED_IN', ':booked': 'BOOKED', ':now': now, ':by': user.sub },
          ReturnValues: 'ALL_NEW',
        }),
      );
      putMetric('CheckInSuccess');
      log.info('check-in succeeded', { eventId, ticketId: payload.tid, scannerId: user.sub });
      return json(event, 200, {
        result: 'CHECKED_IN',
        ticketId: payload.tid,
        eventId,
        eventName: res.Attributes?.eventName ?? null,
        checkedInAt: now,
      });
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
      // Lost the race, or the ticket was used before, or it never existed. Find out which.
      const t = await ddb.send(new GetCommand({ TableName: TABLE(), Key: key, ConsistentRead: true }));
      if (!t.Item) reject('ticket-not-found', 404, 'TICKET_NOT_FOUND', 'No such ticket');
      reject('already-used', 409, 'ALREADY_USED', 'This ticket has already been used', {
        checkedInAt: t.Item?.checkedInAt ?? null,
      });
    }
  } catch (err) {
    if (err instanceof HttpError) {
      return json(event, err.statusCode, { error: err.code, message: err.message, ...err.extra });
    }
    log.error('unhandled error', { error: String(err) });
    return json(event, 500, { error: 'INTERNAL', message: 'Internal server error' });
  }
}
