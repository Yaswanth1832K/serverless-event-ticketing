import type { DynamoDBStreamEvent, DynamoDBRecord, DynamoDBBatchResponse } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from '../../shared/db';
import { log } from '../../shared/logger';
import { putMetric } from '../../shared/metrics';
import { UUID_RE } from '../../shared/validation';

// Turns "ticket went BOOKED -> CHECKED_IN" stream records into analytics counters.
//
// DynamoDB Streams delivers each change AT LEAST once, so a record can arrive twice (a retried
// batch, a Lambda timeout after the write, a replay). Counting naively would double-count.
//
// Idempotency marker: each record is applied in ONE transaction that
//   1. creates a marker item  EVENT#<id> / APPLIED#checkin#<ticketId>   (only if it does not exist)
//   2. adds 1 to the event's checkedIn counter
//   3. adds 1 to that minute's check-in bucket
// If the marker already exists, DynamoDB cancels the whole transaction, so nothing is counted a
// second time. Counters change if and only if the marker is newly written. A ticket can be checked
// in only once (conditional update in /checkin and there is no undo), so the ticket id identifies
// the event exactly.

const MARKER_TTL_SECONDS = 3 * 24 * 60 * 60; // stream records live 24 h, so 3 days is ample
const BUCKET_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_ATTEMPTS = 4;

type Outcome = 'counted' | 'duplicate' | 'skipped';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function reasons(err: unknown): string[] | null {
  const e = err as { name?: string; CancellationReasons?: { Code?: string }[] };
  if (e?.name !== 'TransactionCanceledException') return null;
  return (e.CancellationReasons ?? []).map((r) => r.Code ?? 'None');
}

export async function processRecord(rec: DynamoDBRecord): Promise<Outcome> {
  const oldImg = rec.dynamodb?.OldImage ? unmarshall(rec.dynamodb.OldImage as never) : undefined;
  const newImg = rec.dynamodb?.NewImage ? unmarshall(rec.dynamodb.NewImage as never) : undefined;

  // The event source mapping already filters for this, but never rely on that alone.
  if (
    rec.eventName !== 'MODIFY' || newImg?.entity !== 'TICKET' ||
    oldImg?.status !== 'BOOKED' || newImg?.status !== 'CHECKED_IN'
  ) {
    return 'skipped';
  }

  const { eventId, ticketId, checkedInAt } = newImg as { eventId?: string; ticketId?: string; checkedInAt?: string };
  const when = checkedInAt ? Date.parse(checkedInAt) : NaN;
  if (!eventId || !ticketId || !UUID_RE.test(eventId) || !UUID_RE.test(ticketId) || Number.isNaN(when)) {
    log.error('stream record has unexpected shape, skipped', { eventSeq: rec.dynamodb?.SequenceNumber });
    return 'skipped';
  }

  // Bucket by the time the ticket was scanned, not the time we processed it, so delays and
  // replays still land in the right minute.
  const minute = new Date(when).toISOString().slice(0, 16); // 2026-10-05T07:29
  const nowSec = Math.floor(Date.now() / 1000);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TABLE(),
                Item: {
                  PK: `EVENT#${eventId}`,
                  SK: `APPLIED#checkin#${ticketId}`,
                  entity: 'MARKER',
                  appliedAt: new Date().toISOString(),
                  ttl: nowSec + MARKER_TTL_SECONDS,
                },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Update: {
                TableName: TABLE(),
                Key: { PK: `EVENT#${eventId}`, SK: 'META' },
                UpdateExpression: 'ADD #checkedIn :one',
                ConditionExpression: 'attribute_exists(PK)',
                ExpressionAttributeNames: { '#checkedIn': 'checkedIn' },
                ExpressionAttributeValues: { ':one': 1 },
              },
            },
            {
              Update: {
                TableName: TABLE(),
                Key: { PK: `EVENT#${eventId}`, SK: `CHECKIN#${minute}` },
                UpdateExpression: 'SET entity = :e, #ttl = :ttl ADD #count :one',
                ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
                ExpressionAttributeValues: { ':e': 'CHECKIN_BUCKET', ':ttl': Math.floor(when / 1000) + BUCKET_TTL_SECONDS, ':one': 1 },
              },
            },
          ],
        }),
      );
      putMetric('CheckInCounted');
      return 'counted';
    } catch (err) {
      const codes = reasons(err);
      if (!codes) throw err;
      if (codes[0] === 'ConditionalCheckFailed') {
        // Marker already exists: this record was applied before. Nothing to do.
        putMetric('StreamDuplicateSkipped');
        log.info('duplicate stream record ignored', { eventId, ticketId });
        return 'duplicate';
      }
      if (codes[1] === 'ConditionalCheckFailed') {
        // The event item no longer exists (deleted). Nothing to count, and retrying would loop.
        log.warn('event no longer exists, record skipped', { eventId, ticketId });
        return 'skipped';
      }
      if (codes.some((c) => c === 'TransactionConflict' || c === 'ThrottlingError') && attempt < MAX_ATTEMPTS - 1) {
        await sleep(Math.random() * Math.min(40 * 2 ** attempt, 400));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

// Partial batch response: on the first failure we report that record, and Lambda retries from it.
// Records after it are simply processed again later, which is safe because of the marker.
export async function handler(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  const summary = { counted: 0, duplicate: 0, skipped: 0 };
  for (const rec of event.Records) {
    try {
      summary[await processRecord(rec)]++;
    } catch (err) {
      log.error('stream record failed, batch will be retried from here', {
        error: String(err),
        ...summary,
      });
      return { batchItemFailures: [{ itemIdentifier: rec.dynamodb?.SequenceNumber ?? '' }] };
    }
  }
  log.info('stream batch processed', { records: event.Records.length, ...summary });
  return { batchItemFailures: [] };
}
