import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from '../../shared/db';
import { json, HttpError } from '../../shared/http';
import { getUser } from '../../shared/auth';
import { log } from '../../shared/logger';
import { eventIdFrom, UUID_RE } from '../../shared/validation';
import { signToken } from '../../shared/qr';
import { getQrSecret } from '../../shared/secret';
import type { EventItem } from '../../shared/types';

interface TicketItem {
  ticketId: string;
  eventId: string;
  ownerId: string;
  status: string;
  eventName: string;
  venue: string;
  startsAt: string;
  priceCents: number;
  createdAt: string;
  checkedInAt?: string;
}

// A QR code stays valid until this long after the event starts.
const QR_VALID_AFTER_START_SECONDS = 24 * 60 * 60;

async function myTickets(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const user = getUser(event);
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :u AND begins_with(GSI1SK, :t)',
      ExpressionAttributeValues: { ':u': `USER#${user.sub}`, ':t': 'TICKET#' },
      ScanIndexForward: false,
      Limit: 100,
    }),
  );
  const tickets = (res.Items as TicketItem[]).map((t) => ({
    ticketId: t.ticketId,
    eventId: t.eventId,
    status: t.status,
    eventName: t.eventName,
    venue: t.venue,
    startsAt: t.startsAt,
    priceCents: t.priceCents,
    createdAt: t.createdAt,
    checkedInAt: t.checkedInAt ?? null,
  }));
  return json(event, 200, { tickets });
}

// GET /events/{id}/tickets/{ticketId}/qr: returns the signed QR token for a ticket the caller owns.
// Someone else's ticket gets the same 404 as a ticket that does not exist, so ids cannot be probed.
async function ticketQr(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const user = getUser(event);
  const eventId = eventIdFrom(event.pathParameters);
  const ticketId = event.pathParameters?.ticketId;
  if (!ticketId || !UUID_RE.test(ticketId)) throw new HttpError(404, 'TICKET_NOT_FOUND', 'Ticket not found');

  const t = await ddb.send(
    new GetCommand({ TableName: TABLE(), Key: { PK: `EVENT#${eventId}`, SK: `TICKET#${ticketId}` } }),
  );
  const ticket = t.Item as TicketItem | undefined;
  if (!ticket || ticket.ownerId !== user.sub) {
    throw new HttpError(404, 'TICKET_NOT_FOUND', 'Ticket not found');
  }

  // Expiry follows the event's CURRENT start time (the organizer may have rescheduled).
  const ev = await ddb.send(
    new GetCommand({ TableName: TABLE(), Key: { PK: `EVENT#${eventId}`, SK: 'META' } }),
  );
  const startsAt = (ev.Item as EventItem | undefined)?.startsAt ?? ticket.startsAt;
  const exp = Math.floor(Date.parse(startsAt) / 1000) + QR_VALID_AFTER_START_SECONDS;
  if (exp <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(409, 'EVENT_ENDED', 'This event has ended, so the ticket QR is no longer available');
  }

  const token = signToken(await getQrSecret(), { tid: ticketId, eid: eventId, exp });
  log.info('qr issued', { eventId, ticketId });
  return json(event, 200, {
    ticketId,
    eventId,
    status: ticket.status,
    eventName: ticket.eventName,
    venue: ticket.venue,
    startsAt,
    token,
    expiresAt: new Date(exp * 1000).toISOString(),
  });
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (event.httpMethod === 'GET' && event.resource === '/my/tickets') return await myTickets(event);
    if (event.httpMethod === 'GET' && event.resource === '/events/{id}/tickets/{ticketId}/qr') {
      return await ticketQr(event);
    }
    throw new HttpError(404, 'NOT_FOUND', 'Route not found');
  } catch (err) {
    if (err instanceof HttpError) {
      return json(event, err.statusCode, { error: err.code, message: err.message });
    }
    log.error('unhandled error', { error: String(err) });
    return json(event, 500, { error: 'INTERNAL', message: 'Internal server error' });
  }
}
