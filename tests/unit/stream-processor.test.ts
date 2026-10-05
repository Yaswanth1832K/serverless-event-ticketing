import { describe, it, expect, vi, beforeEach } from 'vitest';

// A tiny in-memory DynamoDB that implements exactly what the processor uses, so a replayed
// record really does hit an existing marker instead of a hand-scripted mock answer.
type Item = Record<string, any>;
const store = new Map<string, Item>();
const keyOf = (k: { PK: string; SK: string }) => `${k.PK}|${k.SK}`;
let failNextWith: Error | undefined;

const cancelled = (...codes: string[]) =>
  Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

const send = vi.fn(async (cmd: any) => {
  if (failNextWith) {
    const e = failNextWith;
    failNextWith = undefined;
    throw e;
  }
  const items = cmd.input.TransactItems as any[];
  // validate every condition first (all or nothing), exactly like a DynamoDB transaction
  const reasons = items.map((it) => {
    if (it.Put) return store.has(keyOf(it.Put.Item)) ? 'ConditionalCheckFailed' : 'None';
    if (it.Update?.ConditionExpression?.includes('attribute_exists')) {
      return store.has(keyOf(it.Update.Key)) ? 'None' : 'ConditionalCheckFailed';
    }
    return 'None';
  });
  if (reasons.some((r) => r !== 'None')) throw cancelled(...reasons);
  for (const it of items) {
    if (it.Put) store.set(keyOf(it.Put.Item), { ...it.Put.Item });
    else {
      const k = keyOf(it.Update.Key);
      const cur = store.get(k) ?? { ...it.Update.Key };
      const attr = Object.values(it.Update.ExpressionAttributeNames as Record<string, string>).find((n) => n === 'checkedIn' || n === 'count')!;
      cur[attr] = (cur[attr] ?? 0) + 1;
      store.set(k, cur);
    }
  }
  return {};
});

vi.mock('../../backend/shared/db', () => ({
  ddb: { send: (cmd: unknown) => send(cmd) },
  TABLE: () => 'test-table',
}));

import { handler, processRecord } from '../../backend/functions/stream-processor/index';

const EID = '22222222-2222-4222-8222-222222222222';
const TID = '11111111-1111-4111-8111-111111111111';
const TID2 = '33333333-3333-4333-8333-333333333333';
const AT = '2026-10-05T07:29:41.123Z';

const s = (v: string) => ({ S: v });
const image = (status: string, ticketId = TID, checkedInAt?: string) => ({
  PK: s(`EVENT#${EID}`), SK: s(`TICKET#${ticketId}`), entity: s('TICKET'), ticketId: s(ticketId), eventId: s(EID),
  status: s(status), ...(checkedInAt ? { checkedInAt: s(checkedInAt) } : {}),
});
const record = (over: Record<string, unknown> = {}, ticketId = TID, seq = '100') =>
  ({
    eventID: `evt-${seq}`, eventName: 'MODIFY', eventSource: 'aws:dynamodb',
    dynamodb: { SequenceNumber: seq, OldImage: image('BOOKED', ticketId), NewImage: image('CHECKED_IN', ticketId, AT) },
    ...over,
  }) as never;

const eventMeta = () => store.get(`EVENT#${EID}|META`)!;
const bucket = (minute: string) => store.get(`EVENT#${EID}|CHECKIN#${minute}`);

beforeEach(() => {
  store.clear();
  store.set(`EVENT#${EID}|META`, { PK: `EVENT#${EID}`, SK: 'META', sold: 5, checkedIn: 0 });
  send.mockClear();
  failNextWith = undefined;
});

describe('idempotency marker', () => {
  it('counts a record once: marker + event counter + minute bucket', async () => {
    expect(await processRecord(record())).toBe('counted');
    expect(eventMeta().checkedIn).toBe(1);
    expect(bucket('2026-10-05T07:29')?.count).toBe(1);
    expect(store.has(`EVENT#${EID}|APPLIED#checkin#${TID}`)).toBe(true);
  });

  it('the SAME record delivered twice does not change any counter twice', async () => {
    expect(await processRecord(record())).toBe('counted');
    expect(await processRecord(record())).toBe('duplicate');
    expect(await processRecord(record())).toBe('duplicate');
    expect(eventMeta().checkedIn).toBe(1);
    expect(bucket('2026-10-05T07:29')?.count).toBe(1);
  });

  it('a replayed BATCH (same records again, plus the same record twice inside one batch) counts each ticket once', async () => {
    const batch = { Records: [record({}, TID, '100'), record({}, TID, '100'), record({}, TID2, '101')] } as never;
    expect(await handler(batch)).toEqual({ batchItemFailures: [] });
    expect(eventMeta().checkedIn).toBe(2);
    // whole batch redelivered, as after a Lambda timeout
    expect(await handler(batch)).toEqual({ batchItemFailures: [] });
    expect(await handler(batch)).toEqual({ batchItemFailures: [] });
    expect(eventMeta().checkedIn).toBe(2);
    expect(bucket('2026-10-05T07:29')?.count).toBe(2);
  });

  it('a different record id for the same ticket is still the same check-in', async () => {
    await processRecord(record({}, TID, '100'));
    expect(await processRecord(record({ eventID: 'another-delivery-id' }, TID, '999'))).toBe('duplicate');
    expect(eventMeta().checkedIn).toBe(1);
  });

  it('two different tickets are two check-ins', async () => {
    await processRecord(record({}, TID, '100'));
    await processRecord(record({}, TID2, '101'));
    expect(eventMeta().checkedIn).toBe(2);
  });

  it('buckets by the scan time, not the processing time', async () => {
    await processRecord(record());
    expect(bucket('2026-10-05T07:29')).toBeDefined();
    expect(Object.keys(Object.fromEntries(store)).filter((k) => k.includes('CHECKIN#'))).toEqual([`EVENT#${EID}|CHECKIN#2026-10-05T07:29`]);
  });
});

describe('record filtering', () => {
  it.each([
    ['an INSERT', record({ eventName: 'INSERT' })],
    ['a REMOVE', record({ eventName: 'REMOVE' })],
    ['a booking-style change (no status transition)', { eventName: 'MODIFY', dynamodb: { SequenceNumber: '1', OldImage: image('BOOKED'), NewImage: image('BOOKED') } }],
    ['an event counter update', { eventName: 'MODIFY', dynamodb: { SequenceNumber: '1', OldImage: { PK: s('EVENT#x'), SK: s('META') }, NewImage: { PK: s('EVENT#x'), SK: s('META') } } }],
    ['a record with no images', { eventName: 'MODIFY', dynamodb: { SequenceNumber: '1' } }],
  ])('skips %s', async (_l, rec) => {
    expect(await processRecord(rec as never)).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
    expect(eventMeta().checkedIn).toBe(0);
  });

  it('skips (and does not retry forever) a malformed record', async () => {
    const bad = record();
    (bad as any).dynamodb.NewImage.eventId = s('not-a-uuid');
    expect(await processRecord(bad)).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a record whose event was deleted instead of failing the batch', async () => {
    store.delete(`EVENT#${EID}|META`);
    expect(await processRecord(record())).toBe('skipped');
    expect(store.has(`EVENT#${EID}|APPLIED#checkin#${TID}`)).toBe(false); // transaction rolled back
  });
});

describe('failure handling', () => {
  it('retries a transient transaction conflict inside the invocation', async () => {
    failNextWith = cancelled('None', 'TransactionConflict', 'None');
    expect(await processRecord(record())).toBe('counted');
    expect(eventMeta().checkedIn).toBe(1);
  });

  it('reports the failing record so only it and later records are retried', async () => {
    const batch = { Records: [record({}, TID, '100'), record({}, TID2, '101')] } as never;
    // first record succeeds, second hits an unexpected error
    send.mockImplementationOnce(async (c: any) => send.getMockImplementation()!(c));
    let calls = 0;
    send.mockImplementation(async (c: any) => {
      calls++;
      if (calls === 2) throw new Error('boom');
      // fall back to the in-memory implementation by re-running the real logic
      const items = c.input.TransactItems as any[];
      for (const it of items) {
        if (it.Put) store.set(keyOf(it.Put.Item), { ...it.Put.Item });
        else {
          const k = keyOf(it.Update.Key);
          const cur = store.get(k) ?? { ...it.Update.Key };
          const attr = Object.values(it.Update.ExpressionAttributeNames as Record<string, string>).find((n) => n === 'checkedIn' || n === 'count')!;
          cur[attr] = (cur[attr] ?? 0) + 1;
          store.set(k, cur);
        }
      }
      return {};
    });
    const res = await handler(batch);
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: '101' }] });
    expect(eventMeta().checkedIn).toBe(1);
  });
});
