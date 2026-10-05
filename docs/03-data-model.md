# 03 – Data Model

## 1. Single table vs multi-table

**Choice: one DynamoDB table (`TicketingTable`) with two GSIs.**

Why:
- The booking transaction touches an event item and its ticket items. A transaction works across items in one table, and multi-table transactions work too, but a single table keeps the key design simple to explain.
- Every access pattern below is a key lookup or a single Query. There are no joins and no ad-hoc reporting.
- One table means one stream, one place to set billing mode and one IAM resource.

Trade-off (stated honestly): single-table items are less readable than separate tables. Prefixed keys (`EVENT#`, `TICKET#`) and the entity table below mitigate this. A multi-table design (Events, Tickets, CheckInBuckets) would also work at this scale.

Billing: **on-demand**. Streams: **NEW_AND_OLD_IMAGES**. Point-in-time recovery: off (free-tier simplicity, noted as future work).

## 2. Keys

| Attribute | Meaning |
|---|---|
| `PK` (S) | Partition key |
| `SK` (S) | Sort key |
| `GSI1PK`, `GSI1SK` | Index 1: items owned by a user (organizer's events, attendee's tickets) |
| `GSI2PK`, `GSI2SK` | Index 2: public event listing by date |

## 3. Entities

### Event
| Attribute | Example / notes |
|---|---|
| `PK` | `EVENT#<eventId>` |
| `SK` | `META` |
| `entity` | `EVENT` |
| `name`, `description`, `venue` | strings, validated length |
| `startsAt` | ISO-8601 UTC |
| `priceCents` | integer (no floats for money) |
| `capacity` | integer, 1..N |
| `sold` | integer, starts at 0, **changed only by the booking transaction** |
| `checkedIn` | integer, starts at 0, **changed only by the stream processor** |
| `imageKey` | S3 key, optional |
| `organizerId` | Cognito `sub` of creator (used for ownership checks) |
| `GSI1PK` / `GSI1SK` | `USER#<organizerId>` / `EVENT#<startsAt>#<eventId>` |
| `GSI2PK` / `GSI2SK` | `EVENTS` / `<startsAt>#<eventId>` |

### Ticket
| Attribute | Example / notes |
|---|---|
| `PK` | `EVENT#<eventId>` |
| `SK` | `TICKET#<ticketId>` |
| `entity` | `TICKET` |
| `status` | `BOOKED` or `CHECKED_IN` |
| `ownerId` | Cognito `sub` of the attendee |
| `createdAt`, `checkedInAt` | ISO-8601 |
| `GSI1PK` / `GSI1SK` | `USER#<ownerId>` / `TICKET#<createdAt>#<ticketId>` |

Stored in the same partition as its event so that the ticket belongs to the event's item collection. The QR token carries `eventId` and `ticketId`, so check-in is a direct `GetItem`/`UpdateItem` with no index needed.

### Check-in bucket (time series)
| Attribute | Example / notes |
|---|---|
| `PK` | `EVENT#<eventId>` |
| `SK` | `CHECKIN#<yyyy-MM-ddTHH:mm>` (one item per minute) |
| `count` | integer, atomic `ADD` |
| `entity` | `CHECKIN_BUCKET` |
| `ttl` | always set: scan time + 30 days, so old buckets expire |

### Idempotency marker
| Attribute | Example / notes |
|---|---|
| `PK` | `EVENT#<eventId>` |
| `SK` | `APPLIED#checkin#<ticketId>` |
| `entity` | `MARKER` |
| `appliedAt` | ISO-8601, when the stream processor applied the record |
| `ttl` | always set: now + 3 days (stream records live 24 hours, so a marker outlives any redelivery) |

Written only by the stream processor, in the same transaction as the counters (see section 7). It has no GSI keys.

## 4. Access patterns

| # | Pattern | Operation |
|---|---|---|
| 1 | Get one event | GetItem `PK=EVENT#id, SK=META` |
| 2 | List upcoming events (public) | Query GSI2 `GSI2PK=EVENTS`, `GSI2SK >= now` |
| 3 | List an organizer's events | Query GSI1 `GSI1PK=USER#org, begins_with(GSI1SK,'EVENT#')` |
| 4 | Book tickets | TransactWriteItems (Update event + Put tickets) |
| 5 | List my tickets | Query GSI1 `GSI1PK=USER#me, begins_with(GSI1SK,'TICKET#')` |
| 6 | Get one ticket (QR, check-in) | GetItem / UpdateItem by `PK`+`SK` |
| 7 | Event analytics: counters | GetItem event META |
| 8 | Event analytics: time series | Query `PK=EVENT#id, begins_with(SK,'CHECKIN#')` |
| 9 | Delete an event | Delete META, allowed only if `sold = 0` (conditional) |

Known limit: pattern 2 uses a single GSI partition key (`EVENTS`). That is fine for hundreds or thousands of events but would need sharding at very large scale.

## 5. Overselling protection

**Invariant:** `0 <= sold <= capacity` at all times.

**Algorithm (read, then one DynamoDB transaction):**

DynamoDB condition expressions cannot do arithmetic, so `sold + :n <= capacity` cannot be written directly. The booking function reads the event, computes the highest `sold` value that still leaves room, and lets DynamoDB enforce it:

```
1. ev = GetItem EVENT#id / META            (ConsistentRead)
2. if ev.capacity - ev.sold < n  ->  409 SOLD_OUT          (fast path, no write)
3. TransactWriteItems [
     Update  EVENT#id / META
             SET sold = sold + :n
             Condition: attribute_exists(PK) AND sold <= :max AND capacity = :cap
             where :max = ev.capacity - n  and  :cap = ev.capacity
     Put     EVENT#id / TICKET#t1   Condition: attribute_not_exists(PK)
     ...     (one Put per ticket, n <= 5)
   ]
4. ConditionalCheckFailed   -> someone else booked first: go to step 1
   TransactionConflict      -> back off with jitter, go to step 1
   (at most 12 attempts, then 503 BUSY)
```

- The read in step 1 is only a hint and may be stale. **Correctness comes from the condition in step 3**, which DynamoDB evaluates against the current stored value. `sold <= capacity - n` is the same inequality as `sold + n <= capacity`.
- `capacity = :cap` makes the transaction fail if an organizer changed the capacity between the read and the write, so `:max` is never computed from an outdated capacity.
- All writes succeed together or none do, so a failed booking never leaves orphan tickets and `sold` never counts tickets that do not exist.
- Concurrent transactions touching the same item do not queue. DynamoDB rejects the loser with `TransactionConflict`. That is **not** a sold-out signal, so it is retried. A sold-out answer is only returned after a fresh read shows too little capacity.
- The transaction has at most 1 + 5 items, well under the 100-item limit.

**Capacity edits:** `UpdateItem` on the event sets `capacity = :new` with condition `:new >= sold`, so an organizer cannot shrink capacity below tickets already sold.

## 6. Check-in correctness

```
UpdateItem EVENT#id / TICKET#t
  SET status = :checked, checkedInAt = :now
  Condition: status = :booked
```

If two scanners race, DynamoDB lets one condition succeed. The other receives `ConditionalCheckFailedException` and the API returns 409 `ALREADY_USED`.

## 7. Analytics counters

| Metric | Written by | Mechanism |
|---|---|---|
| `sold` | booking Lambda | Atomic increment inside the booking transaction (the source of truth, so oversell protection and the count can never disagree) |
| `checkedIn` | stream-processor | On a ticket `BOOKED` to `CHECKED_IN` stream record, `ADD checkedIn 1` on the event |
| Check-ins per minute | stream-processor | On the same record, `ADD count 1` on the `CHECKIN#minute` item |

Why a stream for check-ins but not for `sold`: `sold` must be exact at booking time to enforce capacity, so it lives in the transaction. Check-in counters are for reporting, so asynchronous update with a small delay is fine.

### Idempotent stream processing

DynamoDB Streams delivers each change at least once, so a record can arrive twice (a retried batch, a timeout after the write, a replay). The stream processor therefore applies every `BOOKED` to `CHECKED_IN` record in **one transaction**:

```
TransactWriteItems [
  Put     EVENT#id / APPLIED#checkin#<ticketId>       Condition: attribute_not_exists(PK)   (the marker)
  Update  EVENT#id / META                             ADD checkedIn 1   Condition: attribute_exists(PK)
  Update  EVENT#id / CHECKIN#<yyyy-MM-ddTHH:mm>       ADD count 1       (bucket of the SCAN time)
]
```

- If the marker already exists the whole transaction is cancelled, so no counter moves a second time. The counters change **if and only if** the marker is newly written.
- The ticket id is the idempotency key. This is exact because a ticket can be checked in only once (the conditional update in `/checkin`) and there is no undo.
- Markers expire after 3 days (`ttl`). Stream records live 24 hours, so a marker always outlives any possible redelivery.
- The trigger only fires for ticket records that change from `BOOKED` to `CHECKED_IN`, so counter and marker writes never trigger the processor again (no feedback loop). The handler re-checks the transition anyway.
- Failures use partial batch responses: the first failing record is reported and Lambda retries from it. Records after it are processed again, which is safe because of the marker. After 5 attempts a batch goes to an SQS dead-letter queue.
- A record for a deleted event is skipped instead of retried forever.

What the marker does **not** do: it cannot recover a record that was never delivered (see limitation L25).

## 8. Validation rules (enforced in `backend/shared`)

| Field | Rule |
|---|---|
| name | 1–100 chars |
| description | 0–2000 chars |
| venue | 1–200 chars |
| startsAt | valid ISO date |
| priceCents | integer, 0..1,000,000 |
| capacity | integer, 1..100,000 |
| quantity (booking) | integer, 1..5 |
| token (check-in) | string, bounded length |
