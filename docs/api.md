# API reference

Base URL: the `ApiUrl` stack output (`https://<id>.execute-api.us-east-1.amazonaws.com/prod`). JSON in, JSON out. Protected routes need the Cognito **ID token** in the `Authorization` header (no `Bearer ` prefix). Written from the code and the template; the routes below were all called by the integration, concurrency, e2e or load tests, except where noted.

## Errors

Every error has the same shape: `{ "error": "<CODE>", "message": "<plain words>" }`, sometimes with extra fields (noted below). Requests blocked by API Gateway itself (no or invalid token, throttling) are not in this shape.

| Status | Meaning |
|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_TOKEN`, `TOKEN_EXPIRED` |
| 401 | missing or invalid token (from API Gateway's authorizer) |
| 403 | `FORBIDDEN`: wrong role, or not the owner |
| 404 | `NOT_FOUND`, `TICKET_NOT_FOUND` (also used when a ticket belongs to someone else) |
| 409 | `SOLD_OUT`, `EVENT_STARTED`, `EVENT_ENDED`, `EVENT_HAS_TICKETS`, `CONFLICT`, `WRONG_EVENT`, `ALREADY_USED` |
| 429 | throttled by API Gateway: more than 50 requests/s on one method (burst 100) |
| 503 | `BUSY`: booking gave up after 12 conflict retries (never seen in any test) |
| 500 | `INTERNAL` |

## Routes

| Method and path | Who | Purpose |
|---|---|---|
| `GET /health` | public | Liveness |
| `GET /me` | any signed-in user | Claims seen by the API (id, e-mail, groups) |
| `GET /events` | public | Upcoming events, soonest first, at most 100 |
| `GET /events/{id}` | public | One event |
| `GET /my/events` | Organizer | The caller's events (reads an index, so can lag about 1 s: L3) |
| `POST /events` | Organizer | Create an event |
| `PUT /events/{id}` | Organizer, owner | Update fields of an event |
| `DELETE /events/{id}` | Organizer, owner | Delete an event that has no sold tickets |
| `POST /events/{id}/image-url` | Organizer, owner | Pre-signed POST for the event picture |
| `POST /events/{id}/book` | Attendee | Book 1 to 5 tickets |
| `GET /my/tickets` | any signed-in user | The caller's tickets (at most 100, newest first) |
| `GET /events/{id}/tickets/{ticketId}/qr` | ticket owner | Signed QR token |
| `POST /checkin` | Staff, or Organizer who owns the event | Admit a ticket |
| `GET /dashboard` | Organizer | Totals and event-wise sales across the caller's events |
| `GET /events/{id}/analytics` | Organizer, owner | Counters and check-ins per minute for one event |

### Events

Public view of an event: `eventId, name, description, venue, startsAt, priceCents, capacity, sold, remaining, imageUrl, createdAt`. The owner's view adds fields for the edit form. `organizerId` is never exposed publicly.

`POST /events` body: `name, description, venue, startsAt` (ISO time, in the future), `priceCents` (integer 0 to 1,000,000), `capacity` (integer 1 to 100,000). Returns 201 with the event. `sold`, `checkedIn` and `organizerId` in the body are ignored.
`PUT /events/{id}`: any of the same fields plus `imageKey`. Capacity cannot go below tickets already sold (409 `CONFLICT`). `DELETE`: 409 `EVENT_HAS_TICKETS` if anything was sold.

`POST /events/{id}/image-url` body `{ "contentType": "image/jpeg" | "image/png" | "image/webp", "sizeBytes": 1..2097152 }` returns `{ url, fields, imageKey, maxBytes, expiresInSeconds }` (expiry 120 s). The browser POSTs a multipart form (all `fields`, then `file`) straight to `url`, then saves `imageKey` with `PUT /events/{id}`. S3 enforces the type and size.

### Booking

`POST /events/{id}/book` body `{ "quantity": 1..5 }`.
- 201: `{ eventId, quantity, totalPriceCents, tickets: [{ ticketId, eventId, status: "BOOKED", createdAt }] }`
- 409 `SOLD_OUT`: `{ error, message, remaining }`. 409 `EVENT_STARTED`: booking closed.
- Two identical requests are two bookings (no idempotency key: L16). Overselling is still impossible.

### Tickets and QR

`GET /my/tickets` returns `{ tickets: [{ ticketId, eventId, status, eventName, venue, startsAt, priceCents, createdAt, checkedInAt }] }`.
`GET /events/{id}/tickets/{ticketId}/qr` returns `{ ticketId, eventId, status, eventName, venue, startsAt, token, expiresAt }`. `token` is `v1.<payload>.<signature>` and holds no personal data. 409 `EVENT_ENDED` once the QR has expired.

### Check-in

`POST /checkin` body `{ "token": "<QR token>", "eventId": "<the event being scanned>" }`.

| Result | Status and code |
|---|---|
| Admitted | 200 `{ result: "CHECKED_IN", ticketId, eventId, eventName, checkedInAt }` |
| Forged, edited or malformed token | 400 `INVALID_TOKEN` |
| Expired token | 400 `TOKEN_EXPIRED` |
| Ticket is for another event | 409 `WRONG_EVENT` |
| Signed for a ticket that does not exist | 404 `TICKET_NOT_FOUND` |
| Already admitted, including the losers of simultaneous scans | 409 `ALREADY_USED` with `checkedInAt` of the first scan |
| Attendee, or organizer who does not own the event | 403 `FORBIDDEN` |

### Analytics

`GET /events/{id}/analytics`: `{ eventId, name, startsAt, capacity, sold, remaining, checkedIn, attendancePct, checkInsOverTime: [{ minute, count }], generatedAt }`. Reads the event with a strongly consistent read.
`GET /dashboard`: `{ totals: { totalEvents, ticketsSold, remaining, checkedIn, attendancePct }, events: [...], checkInsOverTime, seriesCoversEvents, generatedAt }`. The combined time series covers at most 20 events (L26); totals cover up to 200.

`checkedIn` is updated by a DynamoDB Stream after the scan, normally within about a second (316 ms measured once), so it can trail the gate (L28). The website polls every 5 seconds.
