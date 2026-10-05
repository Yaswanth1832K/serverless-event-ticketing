# Limitations and simplifications

Kept honest on purpose. Items are grouped by where they come from. This list is extended as later stages add features.

## Events and images (Stage 4)

| # | Limitation | Impact | Possible fix |
|---|---|---|---|
| L1 | **Missing image cleanup.** Deleting an event, or replacing its image, leaves the old object in S3. The events Lambda has no `s3:DeleteObject` permission by design. | Orphaned files cost a few cents at most. | Add `s3:DeleteObject` on `events/*` and delete the old key on update or delete. An S3 lifecycle rule could also expire unreferenced objects. |
| L2 | **No image-existence check.** `PUT /events/{id}` accepts any `imageKey` that is well-formed and under this event's own prefix. It does not confirm that the upload happened. | An organizer can save a key for an object that was never uploaded, so the event shows a broken image. Other events' keys and path tricks are rejected. | `HeadObject` before saving (needs `s3:GetObject`), or an S3 event that marks the image as confirmed. |
| L3 | **`GET /my/events` is eventually consistent.** It reads a global secondary index, and GSI reads cannot be strongly consistent. | A newly created or edited event can take about a second to appear in the organizer's list. `GET /events/{id}` reads the base table and is immediately consistent. | The UI adds the created event locally. Integration tests retry. |

## Booking (Stage 5)

| # | Limitation | Impact | Possible fix |
|---|---|---|---|
| L16 | **No idempotency key (double-click).** `POST /events/{id}/book` has no client-supplied key, so two identical requests are two bookings. A double-click, a retry after a timeout or a flaky network can book twice. Overselling is still impossible, because each request is validated independently, but the buyer may hold unwanted extra tickets. | A user can end up with duplicate tickets and use up seats. | Accept an `Idempotency-Key` header and pass it as the transaction's `ClientRequestToken` (DynamoDB dedupes it for 10 minutes), or store the key on a dedupe item. The frontend will also disable the button while a request is in flight, which reduces but does not remove the problem. |
| L17 | **Hot item under extreme contention.** Every booking for one event updates the same DynamoDB item, and transactions on one item conflict instead of queueing. The function retries up to 12 times with jittered backoff, then returns 503 `BUSY`. | Tested clean with 50 parallel requests (0 of 120 requests ended in 503). Far larger bursts on a single event could produce 503s for buyers who then retry. | Sharded counters, or a queue (SQS FIFO per event) in front of booking. |
| L18 | **No limit per buyer.** One attendee can buy every remaining ticket, 5 at a time. | Hoarding or scalping. | Per-user cap per event, checked inside the transaction. |

## QR and check-in (Stage 6)

| # | Limitation | Impact | Possible fix |
|---|---|---|---|
| L19 | **Staff are not tied to an event or an organizer.** Anyone in the `Staff` Cognito group can admit tickets for **any** event. Only Organizers are restricted, and only to events they own. Staff accounts are created by an admin, never by self-signup. | A staff account issued for one organizer's event could be used to check people into another organizer's event. | Store staff assignments (`EVENT#id / STAFF#sub` items, or an `eventIds` list), created by the event's organizer, and check them in `/checkin`. |
| L20 | **A copied QR works for whoever scans first.** The QR proves the holder has the ticket, not who they are. A screenshot sent to a friend admits the first person to arrive, and the real buyer is then rejected as `ALREADY_USED`. | Ticket sharing or resale cannot be detected. | Bind tickets to a name or ID shown at the gate, or use rotating QR codes that refresh in the app every 30 seconds. |
| L21 | **No secret rotation.** The QR signing key is one SSM SecureString. Replacing it invalidates every issued QR at once (holders must reopen My Tickets), and Lambda containers cache it for up to 5 minutes. | A leaked key forces a manual rotation and brief inconsistency. | Include a key id in the token (`v1` to `v2`) and accept two keys during a rollover. |
| L22 | **Ticket details are a snapshot.** `eventName`, `venue` and `startsAt` on a ticket are copied at booking and not updated if the organizer edits the event. Only the QR expiry follows the event's current start time. | My Tickets can show an old venue or time after an edit. | Join to the event on read, or update tickets from a DynamoDB Stream. |
| L23 | **`CheckInRejected` counts only scans that got as far as the ticket logic** (bad or expired token, wrong event, wrong owner, unknown ticket, already used). Role failures (403), missing credentials (401) and malformed requests (400) are not counted. | The metric slightly understates abuse. API Gateway 4XX metrics cover the rest. | Count role failures too. |
| L24 | **A check-in cannot be undone.** There is no "undo" or manual override for a ticket scanned by mistake. | Staff must handle mistakes outside the system. | Add an organizer-only `CHECKED_IN` to `BOOKED` revert, with an audit record. |

## Analytics (Stage 7)

| # | Limitation | Impact | Possible fix |
|---|---|---|---|
| L25 | **The stream trigger starts at `LATEST`, and records written before it attaches can be lost.** Observed on the first deploy: the trigger was created at 07:58:17Z and the API reported it `Enabled`, yet the check-in at 07:59:30Z was never delivered (no processor invocation, no error, DLQ empty), while every later check-in was counted. The trigger's `LastModified` was 08:00:00Z, which suggests the poller attached about 2 minutes after creation, but the exact cause is **not proven**. The idempotency marker makes duplicates safe, but it cannot recover a record that was never delivered, so the counter is **under-counted** by one in that case. **STATUS: NOT FIXED YET.** The trigger is still `LATEST`. A first attempt to change it to `TRIM_HORIZON` (read from the oldest record) **failed**: Lambda allows only one trigger per stream and function, so CloudFormation's replacement (create the new trigger, then delete the old one) was rejected with `AlreadyExists` (HTTP 409). The stack rolled back (`UPDATE_ROLLBACK_COMPLETE`) and the original trigger is `Enabled`. No fresh-trigger result exists, so nothing here shows that the problem is fixed. | Check-ins recorded in the first minutes after the trigger is created or replaced can be missing from `checkedIn` and the time series. Not a problem in steady state, but it matters on first deploy or whenever the trigger is recreated. | Proposed, awaiting approval: remove the trigger in one deploy and recreate it with `StartingPosition: TRIM_HORIZON` in a second deploy (the marker makes reprocessing safe). Whatever the outcome, one clean run would not prove that a loss can never happen. Until then, tests gate on a canary check-in, not on the `Enabled` state. |
| L26 | **The dashboard's combined time series covers at most 20 events**: the ones that have check-ins, newest first. The response reports how many it covered (`seriesCoversEvents`). Per-event analytics are not capped. Event totals cover up to 200 events. | An organizer with more than 20 active events sees an incomplete combined chart on the dashboard (the totals are still complete). | Maintain a per-organizer minute bucket in the stream processor, so the dashboard reads one partition. |
| L27 | **Dashboard event list is eventually consistent.** It reads the organizer's events through a secondary index, so a counter can lag by about a second. The per-event analytics endpoint reads the base table consistently. | The two views can briefly disagree. | Acceptable at a 5 second polling interval. |
| L28 | **Check-in counters are eventually consistent by design.** The counter appears after the stream delivers the record. Measured at about 0.3 s in the clean run. | The dashboard can trail the gate by a moment, and longer if a batch has to be retried. | Polling every 5 s hides this. A DLQ message (5 failed retries) would mean a permanently missing count and needs manual repair. |
| L29 | **No reconciliation job.** If a stream record is ever lost for good (see L25, or a DLQ message that nobody handles), `checkedIn` stays wrong. The ticket items remain the truth. | A silent drift is possible. | A scheduled job that recounts `CHECKED_IN` tickets per event and corrects the counter. |

## Data and analytics

| # | Limitation | Notes |
|---|---|---|
| L4 | ~~Stream processing is at-least-once, so a retried batch could double-count `checkedIn`.~~ **Resolved in Stage 7** with a per-ticket idempotency marker written in the same transaction as the counters (see `03-data-model.md`). Verified by replaying batches against the deployed stack. | Counters changed once per ticket. See `05-testing.md`. |
| L5 | The public event list uses a single GSI partition key (`EVENTS`) and returns at most 100 events with no pagination. | Fine at student scale. |
| L6 | Point-in-time recovery is off on the DynamoDB table. | Free-tier simplicity. |

## Security and auth

| # | Limitation | Notes |
|---|---|---|
| L7 | Signup is auto-confirmed with no email verification. | Demo simplification (D13). |
| L8 | Anyone can self-register as Organizer. Staff must be added by an admin through Cognito. | An approval flow would be needed in production. |
| L9 | `ALLOW_USER_PASSWORD_AUTH` is enabled on the app client so scripts can log in. | The SPA uses SRP. |
| L10 | A 403 on another organizer's event confirms that the event exists. | Event IDs are public anyway. |
| L11 | CloudFront uses the default `*.cloudfront.net` certificate, so the minimum TLS version is chosen by AWS. | A custom domain would allow TLS 1.2 or newer to be pinned. |
| L12 | API CORS preflight allows a single origin. | API Gateway limitation (D15). |

## Frontend (Stage 8)

| # | Limitation | Impact | Possible fix |
|---|---|---|---|
| L30 | **Sign-in tokens are kept in `sessionStorage`.** They disappear when the tab closes and are not shared between tabs, which is safer than `localStorage`, but any script running on the page (an XSS bug) could still read them. | A cross-site-scripting flaw would expose the session. Mitigated by React escaping all text, a strict Content-Security-Policy (`script-src 'self'`), and no user HTML anywhere. | Short-lived tokens with an HTTP-only cookie via a small backend-for-frontend. |
| L31 | **The CSP uses wildcards for three hosts** (`*.execute-api.<region>.amazonaws.com`, `cognito-idp.<region>.amazonaws.com` is exact, `*.s3.<region>.amazonaws.com`, and `img-src https://*.cloudfront.net`) and allows inline styles (`style-src 'unsafe-inline'`). Naming this stack's own API and image CDN in the policy would make the CloudFormation template circular (their CORS settings refer to the website's distribution). | A script could in theory send data to some other API Gateway or S3 bucket, and images can load from any CloudFront site. Scripts themselves are still restricted to the site's own files. | Put the exact hosts in the policy once a custom domain exists (the circularity then disappears), and remove inline styles. |
| L32 | **The browser test and the camera.** The automated browser tests (Playwright) check the whole journey and the phone layout, but a headless browser cannot point a camera at a QR code. The camera scanner is covered by unit tests of its states and by a manual check, and the code box is the tested fallback. | A camera problem on a specific phone model would not be caught automatically. | Test on real devices before a demo. |
| L33 | **API CORS allows only the website's address.** Local development uses a proxy (`npm run dev`) instead of calling the API directly from `localhost`. | None for users. | None needed. |
| L34 | **The check-in screen offers the public event list to door staff** because staff own no events and there is no "events I am assigned to" list (see L19). | Staff see events from every organizer. | Staff assignments (see L19). |
| L35 | **Prices are shown in one currency** (USD, set in `config.json`). | Not suitable for an event in another currency without changing the setting. | Store a currency per event. |

## Monitoring, load and CI/CD (Stage 9)

| # | Limitation | Impact | Possible fix |
|---|---|---|---|
| L36 | **The API Gateway throttle (50 requests/s, burst 100) applies per method, not to the whole API.** Found by the load tests: a mixed 39 requests/s spike across six methods produced no 429 at all. | The limit protects each endpoint but does not cap total API cost or load. A flood spread over many endpoints is not stopped by it. | An account-level usage plan with an API key or WAF rate rule (costs money, so not enabled). |
| L37 | **Alarm e-mails are only as good as the SNS subscription.** The address must confirm the subscription once. Until then alarms fire but nobody is told. The wiring (alarm to SNS) was tested; e-mail delivery was not, because confirmation is a manual click. | A silent failure if the confirmation e-mail is ignored or lands in spam. | Check the subscription status in the SNS console after every new stack. |
| L38 | **The load tests ran from one laptop over a home or campus network.** The client-side latencies (p50 about 270 ms) include that network. Only 8 attendee identities were used, bookings were spread over 5 events, and the data volume was small (a few hundred tickets). | Not a capacity test. It shows the platform handles about 30 mixed requests/s without errors, not where it breaks. The single hot event case is covered separately by the Stage 5 concurrency test. | Distributed load generation, longer runs, and a single hot event at realistic scale. |
| L39 | **Alarms fire on any single error** (threshold 1 in 5 minutes). Cheap to reason about for a small project, noisy for a busy one. A 503 BUSY from heavy booking contention would count as a 5xx and fire the API alarm, as it should. A 429 throttle is a 4xx and does NOT fire it. | Possible alert noise at scale; no alarm for sustained throttling. | Rate-based thresholds and a throttle alarm. |
| L40 | **The CI/CD pipeline has run green twice, with limits.** Run 4 (manual) and run 5 (started by a push to `main`) both went verify, dev deploy, approved prod deploy, smoke tests (logs in `docs/test-results/ci-run*.txt`; summary in `05-testing.md`). **Not proven:** the `pull_request` trigger (no pull request was opened), failure and rollback paths, and why the prod job of run 2 stayed `queued` without an approval request until it was cancelled (cause unknown). | A pull-request run may behave differently; a failing deploy has not been rehearsed; the unexplained stall could recur. | Open a test pull request; rehearse a failing deploy on `ticketing-dev`. See `docs/ci-cd-setup.md`. |
| L41 | **The CI deploy role is broad.** It can create IAM roles whose name starts with the stack name, and several services are allowed on `*` because AWS does not support resource restrictions for them (Cognito, CloudFront, SQS creation). | Someone who can run the pipeline can create powerful roles inside the stack's name prefix. Mitigated by trust limited to one repository and one environment, and by required approval on prod. | A permissions boundary on the created roles. |
| L42 | **API Gateway renames do not change the metric name.** Renaming the API in the template changed its name but not the `ApiName` dimension CloudWatch reports, so the first dashboard and the 5xx alarm looked at an empty metric until corrected (D24). | A monitoring gap if the API is renamed again. | Do not rename the API; check the metric dimension with `aws cloudwatch list-metrics` after any change. |

## Scope

| # | Limitation |
|---|---|
| L13 | No payment processing. Price is stored and shown, and booking is treated as paid. |
| L14 | Tickets are delivered in-app only (no SES, by design). |
| L15 | Dashboard uses polling, not WebSockets. |
