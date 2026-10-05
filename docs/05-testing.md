# 05 – Testing

Two layers:

| Layer | Command | Runs against | Purpose |
|---|---|---|---|
| Unit | `npm test` | Local code, database mocked | Validation rules, role and ownership logic, signup role rejection |
| Integration | `npm run test:integration` | The **deployed** stack with real Cognito tokens | End-to-end behaviour, including S3 and CloudFront |

The integration tests read stack outputs with the AWS CLI (stack `ticketing-platform`, region `us-east-1`), create their own throw-away users, and delete the users and events they create. Deleting users needs `cognito-idp:AdminDeleteUser`, and cleanup is best-effort.

## Stage 4 – Events CRUD, authorization, image upload

**Unit tests:** 54 passed (validation, authorization with a mocked DB, auth helpers and signup role rules).

**Integration tests:** 27 passed. Full output: [test-results/stage4-integration.txt](test-results/stage4-integration.txt).

What the integration suite proves:

| Area | Checks |
|---|---|
| Signup roles | `Staff` and `Admin` signups are rejected by Cognito. Organizer and no-role signups land in `Organizer` and `Attendee`. |
| Authentication | Public GETs work without a token. Write routes return 401 with no or garbage tokens. |
| Attendee | 403 on create, edit, delete, image-url and `/my/events`. The event is unchanged afterwards. |
| Organizer B vs A's event | 403 on edit, delete and image-url. A's event is unchanged. B's `/my/events` does not list it. |
| Validation | 400 for missing fields, zero capacity, negative price, past date, oversized name, string capacity and non-JSON bodies. Forged `organizerId` and `sold` are ignored. A malformed ID gives 404. |
| Update and visibility | Owner updates succeed and `sold` cannot be changed by the client. The public view contains no `organizerId`. |
| Images | Disallowed types and oversized declarations get 400. A wrong content type is refused by S3 (403) and a file over 2 MB is refused by S3 (400). A valid PNG uploads (204), and a foreign `imageKey` is rejected. The image is served by CloudFront over HTTPS, the direct S3 URL returns 403, and HTTP redirects to HTTPS. The policy expiry is about 120 s. |
| Delete | The owner deletes an unsold event and it then returns 404. |

### Honest note on run history

The first integration run after deploying **failed in test setup**. Organizer A's first `POST /events` returned 403 instead of 201, so all 27 tests were skipped. That output is kept in [test-results/stage4-integration-run0-FAILED-setup.txt](test-results/stage4-integration-run0-FAILED-setup.txt).

Investigation:
- The same request made by hand with curl returned 201.
- A probe of 8 concurrent signups, each logging in immediately, showed every first token already carrying the group (0 of 8 missing), so this was not a signup-to-group race.
- The suite then passed 4 times in a row (27/27 each).

**The cause of the single failure is not identified.** The most likely explanation is an eventual-consistency or propagation effect right after the stack update, but that is a guess. The setup assertion now prints the response body on failure so the next occurrence can be diagnosed. If it recurs, treat it as an open bug.

## Stage 5 – Booking and overselling protection

**Unit tests:** 72 passed in total (18 new for booking: roles, quantity validation, sold-out fast path, transaction shape, retry on conflict, 503 on endless conflict).

**Concurrency tests against the deployed API:** `npm run test:concurrency:x3` (3 full runs). Output: [test-results/stage5-concurrency.txt](test-results/stage5-concurrency.txt). Each run uses 10 different attendee tokens, with all requests in flight at once, after a readiness wait and a 10-request warm-up.

| Run | Validation | Scenario 1 (cap 5, 50 × qty 1) | Scenario 2 (cap 5, 30 × qty 2) | Scenario 3 (cap 5, 40 × mixed) |
|---|---|---|---|---|
| 1 | pass | pass: 5 × 201, 45 × 409 | pass: 2 × 201, 28 × 409 | pass: 4 × 201, 36 × 409 |
| 2 | pass | pass: 5 × 201, 45 × 409 | pass: 2 × 201, 28 × 409 | pass: 3 × 201, 37 × 409 |
| 3 | pass | pass: 5 × 201, 45 × 409 | pass: 2 × 201, 28 × 409 | pass: 4 × 201, 36 × 409 |

Every run: sold equalled 5 in scenario 1 and 4 then 5 in scenario 2. Ticket IDs were all unique and the stored tickets (read back through each buyer's "My Tickets") matched the IDs returned to the buyers. In scenario 3 `sold` always equalled the tickets issued and never exceeded 5.

| Measure | Run 1 | Run 2 | Run 3 | Extra verification run |
|---|---|---|---|---|
| Transaction-conflict retries (`BookingConflictRetry`) | 8 | 15 | 15 | 16 |
| Slowest booking request, client side (ms) | 1939 | 1585 | 1088 | 1764 |
| 503 responses | 0 | 0 | 0 | 0 |

Notes on these numbers:
- Conflict retries for runs 1–3 were counted from the Lambda logs. The metric pipeline was broken then (see below), but the log lines were still written. The extra run's count comes from the CloudWatch metric itself. The extra run's output is in [test-results/stage5-metrics-verification-run.txt](test-results/stage5-metrics-verification-run.txt) and it also passed 4 of 4.
- Client-side latency includes DNS and TLS for 50 new connections, API Gateway, the Cognito authorizer and any cold start. The booking Lambda's own maximum duration over the whole period was 616 ms, so most of the slowest request was outside the function. I did not break that down further.
- Retries are not failures: a retried request still ended as a clean 201 or 409. The booking Lambda recorded 0 errors and 0 throttles. Log searches found no `gave up`, `BUSY`, `unhandled` or `transaction cancelled` lines.
- Most of the 409s come from the fast path (a fresh read shows too little capacity) and never start a transaction.

### Bug found and fixed: custom metrics did not appear

After the first 3 runs, `BookingSuccess`, `BookingRejectedSoldOut` and `BookingConflictRetry` were **missing from CloudWatch**. Cause: the functions use Lambda's JSON log format, and under it `console.log` wraps its argument as an escaped string inside a `message` field, so CloudWatch did not recognise the line as Embedded Metric Format. The same wrapping double-encoded all structured logs.

Fix: `backend/shared/metrics.ts` and `backend/shared/logger.ts` now write with `process.stdout.write`. Verified on the deployed stack: all three metrics now exist, and the extra run's sums match the test output exactly (BookingSuccess 12 = 5 + 3 + 4, BookingRejectedSoldOut 111 = 46 + 29 + 36). Logs now arrive as real top-level JSON fields.

## Stage 6 – QR tokens and check-in

**Unit tests:** 109 passed in total (37 new: token signing and tampering, check-in access control and state changes, QR endpoint ownership).

**Integration tests against the deployed API:** `npm run test:checkin:x3` runs the 18-test file 3 times. Output: [test-results/stage6-checkin.txt](test-results/stage6-checkin.txt). Each run uses fresh users: 2 organizers, a buyer, a stranger and a Staff user promoted with the Cognito admin API. It books 5 tickets and fetches their real QR tokens.

| Test group | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| QR endpoint (owner gets token with no personal data; 4 non-owners get 404 and no token; anonymous, wrong event and malformed ids rejected) | 3/3 pass | 3/3 pass | 3/3 pass |
| Forged, edited, expired, wrong-event and ghost-ticket tokens (8 tampered variants all 400 `INVALID_TOKEN`, expired 400 `TOKEN_EXPIRED`, other event 409 `WRONG_EVENT`, unknown ticket 404; no ticket changed) | 5/5 pass | 5/5 pass | 5/5 pass |
| Role and ownership (Attendee 403, anonymous 401, non-owning Organizer 403, bad input 400, ticket still `BOOKED`) | 5/5 pass | 5/5 pass | 5/5 pass |
| Admission (first scan admitted, duplicate rejected by Staff and by Organizer, owner admits another ticket) | 3/3 pass | 3/3 pass | 3/3 pass |
| 20 simultaneous scans of one ticket, plus simultaneous scans of different tickets | 2/2 pass | 2/2 pass | 2/2 pass |

**20 simultaneous scans of one ticket** (Staff and the owning Organizer alternating, all in flight together):

| Run | 200 | 409 `ALREADY_USED` | 5xx | p50 / max latency |
|---|---|---|---|---|
| 1 | 1 | 19 | 0 | 1174 ms / 1335 ms |
| 2 | 1 | 19 | 0 | 917 ms / 1504 ms |
| 3 | 1 | 19 | 0 | 743 ms / 1061 ms |

The simultaneous scans of the remaining different tickets all returned 200, so there were no false rejections.

**Monitoring evidence (CloudWatch, covering 4 complete runs, see below):**
- `CheckInSuccess` = 20 (5 per run: first scan, owner scan, the parallel winner, and 2 simultaneous different tickets). `CheckInRejected` = 132 (33 per run: 8 tampered + 1 expired + 1 wrong event + 1 ghost + 1 non-owning organizer + 2 duplicates + 19 parallel losers). Both match the test output exactly.
- Lambda: 0 errors and 0 throttles for the check-in and tickets functions. API Gateway: 0 `5XXError`. Slowest check-in invocation 709 ms and slowest tickets invocation 646 ms. Max duration includes cold starts.
- **No token reached the logs.** The check-in function logs the rejection reason only. A search for `eyJ` (how every token payload starts once encoded) found 0 lines, with positive controls confirming the searches work (132 `rejected` lines and 20 `succeeded` lines found).

### Honest note on the first attempt

The first attempt at `npm run test:checkin:x3` ran right after the deploy. **Runs 1 and 2 failed in test setup** and run 3 passed 18 of 18 (1 of 3 overall). The output is kept in [test-results/stage6-checkin-first-attempt-FAILED-setup.txt](test-results/stage6-checkin-first-attempt-FAILED-setup.txt).

Setup received a 403 from **API Gateway itself**: `Authorization header requires 'Credential' parameter...`. That is not a message from our code. It is what API Gateway returns for a route that has not finished propagating after a stack update. My readiness gate only polled the older routes, so it started while the new QR and check-in routes were still coming up.

Fix: `waitForRoutes` in `tests/integration/helpers.ts` now polls every route and counts a route as live only once **our Lambda** answers it with a JSON `error` code. After the fix, a clean `npm run test:checkin:x3` passed 3 of 3.

Two caveats. The fix could not be re-proven against a fresh deploy, because the routes were already live by the time it ran. And this probably explains the unexplained 403 from Stage 4 as well (a route created in that deploy), but the Stage 4 failure's body was not captured, so that remains a likely explanation, not a proven one. Both are consistent with a short propagation window after each deploy, which real users would only hit during a deployment.

## Stage 7 – Analytics and idempotent stream processing

**Unit tests:** 133 passed in total (24 new). The stream-processor tests run against a small in-memory DynamoDB, so a replayed record really meets an existing marker. They cover a replayed batch (three deliveries, with the same record twice inside the batch), record filtering, a malformed record, a deleted event, conflict retries and partial-batch failure reports. The analytics tests cover access control and totals.

**Integration tests against the deployed API:** `npm run test:analytics`. Output: [test-results/stage7-analytics.txt](test-results/stage7-analytics.txt). **13 of 13 passed** on the second attempt (see the honest note below).

| Test group | Tests | Result |
|---|---|---|
| Access control: Attendee 403 on both endpoints (including a buyer of that event), Staff 403, another organizer 403 with an empty dashboard, anonymous 401, unknown and malformed ids 404 | 4 | pass |
| Before any check-in: sold equals the real tickets (20), checked-in 0 | 1 | pass |
| One check-in appears in the counter | 1 | pass, lag 316 ms |
| Idempotency: replayed batch does not count twice | 1 | pass |
| 20 simultaneous check-ins on one event give exactly 20, and still 20 after 10 more seconds; DLQ empty | 2 | pass |
| Counters match the real ticket items in DynamoDB (small event 8 sold / 4 in, big event 20 / 20, dashboard totals over all three events: 29 sold, 25 in) | 3 | pass |
| Dashboard response times | 1 | pass |

**Replay test:** a stream record for an already-counted ticket was built exactly as DynamoDB would redeliver it, and the deployed processor was invoked **twice**, each time with the record **duplicated inside the batch** (4 deliveries). The test asserts the counters before and after: `checkedIn` stayed 1, the per-minute bucket sum stayed 1, and the time series was identical. It then checks `checkedIn` against the ticket items in the table (still 1). The processor's own logs confirm it: both invocations logged `records=2 counted=0 dup=2`, and the `StreamDuplicateSkipped` metric rose by 4. `lambda:InvokeFunction` was **not** denied.

**20 check-ins:** 20 simultaneous scans (Staff and the owning Organizer alternating) all returned 200 in 1.8 s. The analytics endpoint showed `checkedIn` = 20, attendance 100 % and a bucket sum of 20. After a further 10-second wait it was still exactly 20, so nothing counted late or twice.

**Scan-to-counter lag:** 316 ms from the scan being acknowledged until the counter was visible in the analytics endpoint.

**Dashboard response times (client side, includes TLS and API Gateway):**

| Call | n | min | p50 | p95 | max | avg |
|---|---|---|---|---|---|---|
| `GET /dashboard`, sequential | 20 | 274 ms | 691 ms | 990 ms | 990 ms | 653 ms |
| `GET /events/{id}/analytics`, sequential | 20 | 252 ms | 658 ms | 735 ms | 735 ms | 585 ms |
| `GET /dashboard`, 20 concurrent | 20 | 310 ms | 784 ms | 1690 ms | 1690 ms | 895 ms |

(With n = 20, p95 and max are the same sample.)

**Operations evidence:** DLQ depth 0 (both in-test and checked again afterwards). Stream-processor Lambda: 0 errors, 0 throttles, maximum duration 581 ms. Analytics Lambda: 0 errors. `CheckInCounted` = 48 in CloudWatch, which is 23 from the first attempt plus 25 from the second.

### Honest note: the first attempt lost a record

The first run failed 4 of 13 tests, and all four trace to **one check-in that was never counted**. The output is kept in [test-results/stage7-analytics-first-attempt-FAILED-lost-first-record.txt](test-results/stage7-analytics-first-attempt-FAILED-lost-first-record.txt).

- The suite's setup waited for the stream trigger to report `Enabled`, then scanned a ticket at 07:59:30.780Z. The counter stayed at 0 for the full 60 seconds. Later scans were counted normally (the 20-check-in test passed with exactly 20, and the 3 further scans on the same event were counted).
- The processor logs show no invocation for that record: 23 of 24 check-ins were delivered. There were no processor errors and the DLQ was empty. The record has the same shape as later ones that were processed, so the filter was not the cause.
- Timeline: trigger created 07:58:17Z, scan 07:59:30Z (73 s later), trigger `LastModified` 08:00:00Z, first processed batch 08:00:34Z.
- **Most likely cause:** the trigger starts at `LATEST`, and records written before its poller attaches are skipped. `Enabled` does not mean the poller has attached. This fits the evidence but is **not proven**.
- The replay test failed only because its precondition (the counter already being 1) was false. Its `lambda:InvokeFunction` call was never reached in that run.

What I changed: the readiness gate no longer trusts `Enabled`. A canary event is booked, scanned and polled until a counter moves, and nothing else runs before that. The second attempt (13 of 13) ran against a trigger that had been live for several minutes, so **it does not prove that a fresh deployment is safe**. This is now limitation **L25**, with the proposed fix (`TRIM_HORIZON`, which the idempotency marker makes safe) awaiting approval because it replaces the trigger.

### Attempt to apply the `TRIM_HORIZON` fix (failed, nothing changed)

A fresh-trigger harness was written (`tests/fresh-trigger`, `scripts/run-fresh-trigger-series.mjs`). It disables the old trigger, runs a real `sam deploy` that replaces it, scans a ticket the moment the new trigger appears and again when the API first reports it `Enabled`, and checks the per-ticket idempotency markers. The first run is kept in [test-results/stage7b-fresh-trigger-attempt1-FAILED-replacement-rejected.txt](test-results/stage7b-fresh-trigger-attempt1-FAILED-replacement-rejected.txt).

**It failed before any scan, and the cause was my plan, not the harness:**
- The deploy's replacement of the trigger was rejected by Lambda: `The event source arn (...) and function (...) provided mapping already exists ... (Status Code: 409 ... AlreadyExists)`.
- I had assumed CloudFormation could create the new trigger while the old one still existed. It cannot: Lambda allows only one trigger per stream and function. My earlier description of the changeset ("the two overlap briefly, harmless") was wrong.
- CloudFormation rolled the stack back (`UPDATE_ROLLBACK_COMPLETE`). The harness then waited 8 minutes for a trigger that could never appear and failed with "new trigger never appeared". It should have noticed the failed deploy sooner (to be fixed).
- **Final state:** one stream trigger, `Enabled`, starting position `LATEST` (unchanged). The harness re-enabled the trigger it had disabled. The event and test users were cleaned up. The fix has **not** been applied and there is **no** fresh-trigger result.

## Stage 8 – Frontend

**Unit and component tests (`npm run frontend:test`):** 68 passed. They cover the plain-words error messages, the API client (token on protected calls only, a 401 ending the session, network failures, non-JSON error bodies), and every page's loading, error and empty states. They also cover double-click-safe booking, sold-out handling, the registration form offering only Attendee and Organizer, route guards, the scanner's five rejection messages, form validation, and delete with a confirmation.

**Browser tests against the deployed site (`npm run e2e`, Playwright and Chromium):** 5 passed. Output: [test-results/stage8-e2e.txt](test-results/stage8-e2e.txt). The script removes its own test users and events afterwards.

| Test | What it proves |
|---|---|
| Site basics | HTTPS site with CSP, HSTS, `X-Frame-Options: DENY`, `nosniff` and a camera-only Permissions-Policy. `config.json` has exactly 5 public keys and no secrets. `http://` redirects to `https://`. |
| Deep links | `/my-tickets` while signed out lands on Sign in. An unknown path shows "can't find that page". |
| Full journey (desktop) | An organizer registers and creates an event. An attendee registers, finds it, books 2 tickets, opens a ticket, and the QR canvas contains real dark squares. The ticket code matches `v1.<payload>.<signature>` and has no `@`. The organizer pastes it into Check-in and gets "Checked in". A second scan gives "Already used", and a made-up code gives "Not a valid ticket". The attendee's own screen flips to "used" by itself. The dashboard shows 50 % and "2 of 5 sold". An attendee opening `/organizer` or `/scan` is refused in words. |
| Phone layout | On a Pixel 7: `/`, `/login`, `/register`, `/my-tickets` and an error page never scroll sideways. The Menu button opens and closes the links, and every visible button is at least 36 px tall. |
| Phone, signed in | Signed-in pages fit, and an unknown event shows a plain message. |

**Run history (kept as evidence):**
1. [Attempt 1](test-results/stage8-e2e-attempt1-FAILED-phone-test-race.txt): 4 of 5 passed. The phone test failed because it measured button heights before the app had drawn the page (the failure screenshot is completely blank). It was a **timing mistake in my test, not an app bug**.
2. [Run 2](test-results/stage8-e2e-run2-before-ui-fixes-5of5.txt): 5 of 5 passed after making the test wait for the page.
3. **Final run: 5 of 5**, after the UI fixes below.

**Problems found by looking at the screenshots (the tests passed, but the pages were wrong), and fixed:**
- The **Menu button also showed on desktop** next to the full navigation, because a later CSS rule overrode the one that hides it.
- On the Check-in page the **verdict ("Already used") appeared below the camera and the code box**, so on a phone door staff would have had to scroll to see it. It now sits directly under the event picker.
- Two phone screenshots were taken before the page finished loading (one blank, one stuck on "Loading…"), so the test now waits for the content.

**Not covered by automated tests:** the live camera scanner on a real phone (a headless browser has no camera). The scanner's states and the typed-code path are tested; see limitation L32.

## Stage 9: monitoring, load tests, lint and CI/CD

### Deployed and verified (stack `ticketing-platform`, 2026-10-05)
- `sam deploy` created the SNS topic, 4 alarms and the dashboard (13 widgets). Evidence: `docs/test-results/stage9-deploy-verification.txt`. The stream trigger was untouched (still one, Enabled, `LATEST`).
- All 4 alarms read `OK` after their first data. State before and after each load test is saved in `stage9-alarm-states-*.txt`. **No alarm fired during any load test.** That was the expected result: the tests produced 0 Lambda errors, 0 5xx, 0 DynamoDB throttles and an empty DLQ. The 1162 throttled requests in the throttle test are HTTP 429, a 4xx, which the 5xx alarm does not count.
- Wiring test: forcing the DLQ alarm to `ALARM` by hand made CloudWatch run its SNS action ("Successfully executed action ...AlarmTopic", `stage9-alarm-wiring-test.txt`), and the alarm returned to `OK` on its own. **Not verified: e-mail delivery.** The SNS subscription was `PendingConfirmation` (the address must click the confirmation link), and no alarm has ever fired for a real failure.
- Frontend republished and the Playwright suite rerun after the UI-string changes: 5/5 (`stage9-e2e-after-ui-strings.txt`).

### A monitoring bug found by the first load test
The first deploy renamed the API (`<stack>-api`) so the alarm and dashboard could name it. The first steady load test then showed **0 requests counted by API Gateway** in CloudWatch. CloudWatch was still reporting under the old name, so the 5xx alarm and the API widgets watched an empty metric. Fixed by dropping the explicit name and using the stack name as `ApiName` (D24, L42), redeployed (3 in-place modifications, no replacement), and the first run was repeated. The failed first run is kept: `stage9-loadtest-steady-run1-api-metrics-missing-wrong-dimension.*`. Its client-side results were fine; only the server-side API evidence was missing.

### Load tests (Artillery, `loadtest/`, run with `npm run loadtest*`)
All traffic goes through the real API with a dedicated organizer, 8 dedicated attendees and 5 dedicated events of capacity 100000, all created by the runner and deleted afterwards. The demo event and demo accounts were not touched.

| Run | Requests | Avg req/s (peak) | p50 | p95 | p99 | Max | 429 | 5xx | Error rate | Data check |
|---|---|---|---|---|---|---|---|---|---|---|
| Steady mixed, 136 s (`stage9-loadtest-steady.*`) | 2881 | 21.2 (30) | 273 ms | 672 ms | 743 ms | 1841 ms | 0 | 0 | 0.00 % | 269 tickets sold = 269 HTTP 201 |
| Mixed spike to about 3x, 50 s (`stage9-loadtest-spike-mixed-run1-did-not-reach-limit.*`) | 1935 | 38.5 (32) | 263 ms | 633 ms | 686 ms | 1118 ms | 0 | 0 | 0.00 % | 185 sold = 185 HTTP 201 |
| Throttle, one endpoint at 120 arrivals/s for 20 s (`stage9-loadtest-throttle.*`) | 2500 | 62.4 (50) | 263 ms | 672 ms | 1130 ms | 1633 ms | **1162 (46.5 %)** | 0 | 46.5 % counting 429 as errors | no bookings |

- Latencies are measured by the load generator on a laptop over a home or campus network (L38). Requests per second are the average over the whole run including warm-up and recovery; "peak" is Artillery's own figure.
- **No 503 BUSY and no 5xx** appeared in any run. Server side: 0 Lambda errors, 0 Lambda throttles, 0 DynamoDB throttle events; peak 3 to 6 concurrent Lambda executions in the mixed runs and 38 in the throttle run. The steady run showed 0 booking conflict retries (the first run, with wrong API metrics, showed 1).
- **The mixed spike did not reach the API Gateway limit**, so it produced no 429. The 50 requests/s limit is per method (L36). The throttle test exists because of that finding. In it API Gateway answered 1162 of 2500 requests with 429 and let 1338 through; Lambda saw 1362 invocations (the 1338 plus a few setup calls); nothing behind the API was throttled.
- **Nothing lost or double-counted:** in the steady and mixed-spike runs the tickets sold in the database equalled the number of successful booking responses (269 and 185), and the `BookingSuccess` metric matched. The runs did not check anyone in, so the analytics counters were not exercised under load (the idempotent counters are tested in Stage 7).
- Not tested: one hot event under load at scale (Stage 5 covers 50 parallel requests), a long soak run, and failure of the stream processor under load.

### Lint, typecheck and unit tests (run locally, the same commands CI runs)
- `npm run lint` (Biome): first run 20 errors, 137 warnings. Fixed: list keys built from an index (Scanner), an untyped variable, assignments inside expressions in a test, wording of image alt texts, and a11y markup on the chart. Intentional cases got a written `biome-ignore` reason (control-character regexes that exist to reject those characters, hook dependency lists that are deliberate). Now **0 errors, 33 warnings** (mostly `any` in tests). Formatting and the non-null-assertion rule are switched off (D27).
- `npm run typecheck`: passes. `npm test`: **133/133**. Frontend `typecheck` passes and frontend tests **68/68**. `sam validate --lint`: valid.

### Not verified
- **The GitHub Actions workflow (`.github/workflows/ci-cd.yml`) has never run.** Written, not verified (L40). Its steps were run individually on this machine; the OIDC role, the policy in `ci/`, the environments and the approval gate have never been exercised. Setup: `docs/ci-cd-setup.md`.
- E-mail delivery of alarms (L37).

## Final re-run on the final deployment (2026-10-05, after the Stage 9 redeploys)

The Stage 4 to 8 suites last ran before the Stage 9 deploys, so they were run again against the current stack, one after the other. **Everything passed on the first attempt; there were no failures to keep.** Outputs: `docs/test-results/final-rerun-*.txt`.

| Suite | Result | Notable numbers | File |
|---|---|---|---|
| Stage 4 events, roles, images | 27/27 | 61.5 s | `final-rerun-stage4-events-integration.txt` |
| Stage 5 concurrency, 3 runs | 12/12 (4 tests x 3 runs) | scenario 1: 5 x 201 and 45 x 409 in every run; scenario 2: 2 / 28 every run; scenario 3: 4 / 36, 4 / 36, 3 / 37 | `final-rerun-stage5-concurrency.txt` |
| Stage 6 check-in, 3 runs | 54/54 (18 tests x 3 runs) | 20 simultaneous scans: 1 x 200 and 19 x 409 in every run; p50 / max 1558 / 2089, 1041 / 1635, 844 / 1052 ms | `final-rerun-stage6-checkin.txt` |
| Stage 7 analytics | 13/13 | scan to counter 308 ms; 20 simultaneous check-ins all 200 in 1673 ms and counted exactly 20; dashboard sequential p50 700 ms and p95 814 ms; analytics endpoint p50 781 ms and p95 1177 ms | `final-rerun-stage7-analytics.txt` |
| Stage 8/9 browser tests (Playwright) | 5/5 | 1.4 min | `final-rerun-e2e.txt` |

Differences from the first runs worth stating: the 20-concurrent `GET /dashboard` calls had p50 2008 ms and p95 2076 ms this time against 784 ms and 1690 ms in the first Stage 7 run. I did not investigate why (single measurement each time, from a laptop). The metric `StreamDuplicateSkipped` and the DLQ were not re-inspected in detail; the DLQ held 0 messages afterwards and all four alarms read OK.

**Clean-up verified afterwards:** the user pool holds the same 6 users as before the runs (the 5 demo accounts and the old Stage 3 account `org-test-831506129@...`), the only event in the table is `[DEMO] Campus Tech Fest` (6 of 10 sold, unchanged), DLQ depth 0.

The e2e run rewrote the screenshots in `docs/screenshots/` (same file names).

## Not yet tested

- Stage 10 documents (README deploy and clean-up steps, final diagrams, report outline, slides) are written, **not executed or rendered**. The README's deploy-from-scratch and clean-up commands have never been run end to end. The complete list of unverified statements, with suggested wording, is in [unverified-claims.md](unverified-claims.md).
