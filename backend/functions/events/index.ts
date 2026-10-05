import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { ddb, TABLE, isConditionalFailure } from '../../shared/db';
import { json, HttpError } from '../../shared/http';
import { getUser, requireRole, type AuthUser } from '../../shared/auth';
import { log } from '../../shared/logger';
import {
  parseBody,
  validateEvent,
  validateImageRequest,
  eventIdFrom,
  MAX_IMAGE_BYTES,
} from '../../shared/validation';
import type { EventItem } from '../../shared/types';

const s3 = new S3Client({});
const UPLOAD_URL_TTL_SECONDS = 120;

type Route = (e: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

// ---------------------------------------------------------------- helpers

const eventIdOf = (e: APIGatewayProxyEvent): string => eventIdFrom(e.pathParameters);

function imageUrlFor(item: EventItem): string | null {
  const base = process.env.IMAGE_BASE_URL;
  return item.imageKey && base ? `${base}/${item.imageKey}` : null;
}

// Public view: no internal keys and no organizerId.
function publicView(item: EventItem) {
  return {
    eventId: item.eventId,
    name: item.name,
    description: item.description,
    venue: item.venue,
    startsAt: item.startsAt,
    priceCents: item.priceCents,
    capacity: item.capacity,
    sold: item.sold,
    remaining: Math.max(item.capacity - item.sold, 0),
    imageUrl: imageUrlFor(item),
    createdAt: item.createdAt,
  };
}

// Organizer view of their own event adds the fields the edit form and dashboard need.
function ownerView(item: EventItem) {
  return {
    ...publicView(item),
    checkedIn: item.checkedIn,
    imageKey: item.imageKey ?? null,
    updatedAt: item.updatedAt,
  };
}

async function loadEvent(id: string): Promise<EventItem> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE(), Key: { PK: `EVENT#${id}`, SK: 'META' } }),
  );
  if (!res.Item) throw new HttpError(404, 'NOT_FOUND', 'Event not found');
  return res.Item as EventItem;
}

// Ownership check: only the creator may modify an event.
async function loadOwnedEvent(id: string, user: AuthUser): Promise<EventItem> {
  const item = await loadEvent(id);
  if (item.organizerId !== user.sub) {
    throw new HttpError(403, 'FORBIDDEN', 'You do not own this event');
  }
  return item;
}

// ---------------------------------------------------------------- routes

const listEvents: Route = async (e) => {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :p AND GSI2SK >= :now',
      ExpressionAttributeValues: { ':p': 'EVENTS', ':now': new Date().toISOString() },
      Limit: 100,
    }),
  );
  return json(e, 200, { events: (res.Items as EventItem[]).map(publicView) });
};

const getEvent: Route = async (e) => {
  const item = await loadEvent(eventIdOf(e));
  return json(e, 200, publicView(item));
};

const myEvents: Route = async (e) => {
  const user = getUser(e);
  requireRole(user, 'Organizer');
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :u AND begins_with(GSI1SK, :e)',
      ExpressionAttributeValues: { ':u': `USER#${user.sub}`, ':e': 'EVENT#' },
    }),
  );
  return json(e, 200, { events: (res.Items as EventItem[]).map(ownerView) });
};

const createEvent: Route = async (e) => {
  const user = getUser(e);
  requireRole(user, 'Organizer');
  const eventId = randomUUID();
  const input = validateEvent(parseBody(e.body), 'create', eventId);
  const now = new Date().toISOString();

  const item: EventItem = {
    PK: `EVENT#${eventId}`,
    SK: 'META',
    entity: 'EVENT',
    eventId,
    name: input.name!,
    description: input.description ?? '',
    venue: input.venue!,
    startsAt: input.startsAt!,
    priceCents: input.priceCents!,
    capacity: input.capacity!,
    sold: 0,
    checkedIn: 0,
    organizerId: user.sub,
    createdAt: now,
    updatedAt: now,
    GSI1PK: `USER#${user.sub}`,
    GSI1SK: `EVENT#${input.startsAt}#${eventId}`,
    GSI2PK: 'EVENTS',
    GSI2SK: `${input.startsAt}#${eventId}`,
  };
  await ddb.send(
    new PutCommand({
      TableName: TABLE(),
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
  log.info('event created', { eventId, organizerId: user.sub });
  return json(e, 201, ownerView(item));
};

const updateEvent: Route = async (e) => {
  const user = getUser(e);
  requireRole(user, 'Organizer');
  const id = eventIdOf(e);
  await loadOwnedEvent(id, user);
  const patch = validateEvent(parseBody(e.body), 'update', id);

  const names: Record<string, string> = { '#updatedAt': 'updatedAt', '#org': 'organizerId' };
  const values: Record<string, unknown> = {
    ':updatedAt': new Date().toISOString(),
    ':me': user.sub,
  };
  const sets = ['#updatedAt = :updatedAt'];
  for (const f of ['name', 'description', 'venue', 'priceCents', 'capacity', 'imageKey'] as const) {
    if (patch[f] !== undefined) {
      sets.push(`#${f} = :${f}`);
      names[`#${f}`] = f;
      values[`:${f}`] = patch[f];
    }
  }
  if (patch.startsAt) {
    sets.push('#startsAt = :startsAt', 'GSI1SK = :g1', 'GSI2SK = :g2');
    names['#startsAt'] = 'startsAt';
    values[':startsAt'] = patch.startsAt;
    values[':g1'] = `EVENT#${patch.startsAt}#${id}`;
    values[':g2'] = `${patch.startsAt}#${id}`;
  }

  // The owner check is repeated inside the write so it is atomic with the update.
  // Capacity may not drop below tickets already sold (evaluated by DynamoDB, so it is race-free).
  let condition = 'attribute_exists(PK) AND #org = :me';
  if (patch.capacity !== undefined) {
    condition += ' AND #sold <= :capacity';
    names['#sold'] = 'sold';
  }

  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: { PK: `EVENT#${id}`, SK: 'META' },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return json(e, 200, ownerView(res.Attributes as EventItem));
  } catch (err) {
    if (isConditionalFailure(err)) {
      const msg =
        patch.capacity !== undefined
          ? 'Capacity cannot be lower than tickets already sold'
          : 'Event changed or was deleted, please reload';
      throw new HttpError(409, 'CONFLICT', msg);
    }
    throw err;
  }
};

const deleteEvent: Route = async (e) => {
  const user = getUser(e);
  requireRole(user, 'Organizer');
  const id = eventIdOf(e);
  await loadOwnedEvent(id, user);
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE(),
        Key: { PK: `EVENT#${id}`, SK: 'META' },
        ConditionExpression: '#org = :me AND #sold = :zero',
        ExpressionAttributeNames: { '#org': 'organizerId', '#sold': 'sold' },
        ExpressionAttributeValues: { ':me': user.sub, ':zero': 0 },
      }),
    );
  } catch (err) {
    if (isConditionalFailure(err)) {
      throw new HttpError(409, 'EVENT_HAS_TICKETS', 'Events with sold tickets cannot be deleted');
    }
    throw err;
  }
  log.info('event deleted', { eventId: id, organizerId: user.sub });
  return json(e, 200, { deleted: true });
};

// Returns a pre-signed POST so the browser uploads straight to S3. The policy, signed by the
// Lambda role, makes S3 itself enforce the content type and size, so a client cannot bypass it.
const imageUploadUrl: Route = async (e) => {
  const user = getUser(e);
  requireRole(user, 'Organizer');
  const id = eventIdOf(e);
  await loadOwnedEvent(id, user);
  const { contentType, ext } = validateImageRequest(parseBody(e.body));

  const key = `events/${id}/${randomUUID()}.${ext}`;
  const post = await createPresignedPost(s3, {
    Bucket: process.env.IMAGE_BUCKET!,
    Key: key,
    Fields: { 'Content-Type': contentType },
    Conditions: [
      ['content-length-range', 1, MAX_IMAGE_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Expires: UPLOAD_URL_TTL_SECONDS,
  });
  return json(e, 200, {
    url: post.url,
    fields: post.fields,
    imageKey: key,
    maxBytes: MAX_IMAGE_BYTES,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  });
};

const routes: Record<string, Route> = {
  'GET /events': listEvents,
  'GET /events/{id}': getEvent,
  'GET /my/events': myEvents,
  'POST /events': createEvent,
  'PUT /events/{id}': updateEvent,
  'DELETE /events/{id}': deleteEvent,
  'POST /events/{id}/image-url': imageUploadUrl,
};

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const route = routes[`${event.httpMethod} ${event.resource}`];
    if (!route) throw new HttpError(404, 'NOT_FOUND', 'Route not found');
    return await route(event);
  } catch (err) {
    if (err instanceof HttpError) {
      return json(event, err.statusCode, { error: err.code, message: err.message });
    }
    log.error('unhandled error', { error: String(err), resource: event.resource });
    return json(event, 500, { error: 'INTERNAL', message: 'Internal server error' });
  }
}
