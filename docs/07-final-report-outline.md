# 07 – Final report outline

A section-by-section outline with the real numbers filled in. Every number comes from a file in `docs/test-results/` (named in brackets), so you can open the source. Where a statement is **not verified**, the outline says so and gives wording you can use; the full list is in [unverified-claims.md](unverified-claims.md).

Not researched: I did not look up or cite any existing ticketing product, paper or price list. Section 3 describes common approaches in general terms. **Add references before you submit.**

---

## Title
Serverless Event Ticketing and QR Check-in Platform on AWS with Overselling Protection and Live Attendance Analytics

## 1. Abstract (draft, about 170 words)

> Small event organizers often sell tickets through forms and spreadsheets, which allows overselling, copied tickets and no live view of attendance. This project builds a serverless ticketing platform on AWS (API Gateway, Lambda, DynamoDB, Cognito, S3, CloudFront) defined entirely in AWS SAM. Overselling is prevented inside the database with a single conditional transaction; in tests against the deployed system, 50 simultaneous buyers competing for 5 tickets produced exactly 5 bookings and 45 sold-out answers, in three repeated runs. Each ticket carries a signed QR token with no personal data and can be admitted exactly once: 20 simultaneous scans of one ticket produced 1 admission and 19 rejections in every run. Organizers see attendance on a dashboard fed by DynamoDB Streams with idempotent counters; a replayed stream batch did not change a counter, and 20 check-ins counted exactly 20. A React web app, a CloudWatch dashboard with four alarms, and Artillery load tests (about 2,900 requests with no errors at 30 requests per second) complete the system. Limitations, including one open stream-trigger issue and a CI pipeline proven only by one manual run, are documented.

(Every number above is from [stage5-concurrency.txt], [stage6-checkin.txt], [stage7-analytics.txt], [stage9-loadtest-steady.txt].)

## 2. Introduction and objectives

Problem statement: [01-requirements.md](01-requirements.md) section 1. Objectives and their status:

| # | Objective | Status | Evidence |
|---|---|---|---|
| O1 | Never oversell | **Met, tested** | cap 5, 50 parallel buyers: 5 x 201 and 45 x 409 in each of 3 runs; two further scenarios (cap 5 with 30 requests of qty 2, and 40 mixed) also held; 0 of 120 requests per run ended in 503; `sold` never exceeded 5 [stage5-concurrency.txt] |
| O2 | A ticket is admitted exactly once | **Met, tested** | 20 simultaneous scans: 1 x 200 and 19 x 409 in each of 3 runs, 0 5xx [stage6-checkin.txt] |
| O3 | QR carries no personal data and cannot be forged | **Met, tested** | 8 tampered variants rejected, expired, wrong-event and ghost-ticket cases rejected, no token in any log [stage6-checkin.txt] |
| O4 | Near-real-time attendance | **Met, tested** | scan to counter 316 ms (one measurement); the page polls every 5 s [stage7-analytics.txt] |
| O5 | Role-based access with ownership checks | **Met, tested** | attendee 403 on write routes, organizer B 403 on A's event, non-owners 404 on QR, attendee 403 on analytics [stage4, 6, 7] |
| O6 | Serverless, free-tier | **Serverless: met. Free-tier: not measured** | no always-on resource; no billing data was looked at. Say "designed for" not "stayed within" |
| O7 | Reproducible deploy and observability | **Partly** | `sam deploy` and the dashboard and alarms were deployed and verified; **the GitHub Actions pipeline ran green once by manual trigger** (push trigger not enabled, failure paths untried) |

## 3. Existing approaches versus the proposed system

General description only (no sources; add references).

| | Forms and spreadsheets | Server-based ticketing app | **This project** |
|---|---|---|---|
| Overselling under a burst | possible (read, then write) | depends on locking in the app | prevented by one atomic database condition (tested) |
| Idle cost | none | a server running all the time | no always-on compute |
| Duplicate entry | paper or image tickets can be copied | depends | each ticket admitted once, enforced by the database (tested); a copied QR still works for the first scanner (L20) |
| Live attendance | after the event | depends | dashboard, about 5 s polling |
| Setup and scaling | manual | sized for the peak | scales per request; scale beyond the tests was not measured (L38) |

Out of scope and stated as such: payment (L13), e-mail or SMS delivery (L14), refunds, waitlists, seat maps, custom domain, WAF.

## 4. Architecture

Use [architecture-diagram.md](architecture-diagram.md) (system overview, data model, delivery) and the two sequence diagrams in [02-architecture.md](02-architecture.md) (booking, check-in). Key choices to explain, each recorded in [decisions.md](decisions.md): single-table DynamoDB (D2), `sold` changed only by the booking transaction and `checkedIn` only by the stream (D3), SQS only as a dead-letter queue (D4), polling instead of WebSockets (D7, and section 8 of 02-architecture), SAM as the only IaC tool.

## 5. Modules

| Module | Scope | Where |
|---|---|---|
| A: Booking and database | single-table model, events CRUD, transactional booking, tickets, analytics counters, idempotent stream processing | `backend/functions/{events,booking,tickets,analytics,stream-processor}`, [03-data-model.md](03-data-model.md) |
| B: Auth and security | Cognito, roles by group, signup role hardening, QR signing, check-in, IAM, headers, upload limits | `backend/functions/{checkin,auth-triggers}`, `backend/shared/{auth,qr,secret,validation}.ts`, [06-security.md](06-security.md) |
| C: DevOps and monitoring | SAM template, EMF metrics, dashboard, 4 alarms, load tests, CI/CD workflow | `template.yaml`, `loadtest/`, `.github/workflows/ci-cd.yml`, [ci-cd-setup.md](ci-cd-setup.md) |
| D: Frontend and docs | React app, route guards, QR display and camera scanner, charts, demo seeding, all documents | `frontend/`, `scripts/seed-demo.mjs`, `docs/` |

(If the team split work by module, put names here. The repository does not record who wrote what.)

## 6. Implementation highlights

1. **Overselling protection.** DynamoDB conditions cannot do arithmetic, so the function reads the capacity, computes `capacity - n`, and the transaction's condition is `sold <= :max AND capacity = :cap`, updated with `sold = sold + n`, plus one Put per ticket. If another buyer wins first the condition fails and the request re-reads. Transaction conflicts are retried (up to 12 times, jittered); sold out is declared only after a fresh read. An early draft of the docs used `sold + n <= capacity`, which is not valid DynamoDB; this was corrected (record: [05-testing.md](05-testing.md), Stage 5).
2. **QR token.** `v1.<payload>.<HMAC-SHA256>`, payload = ticket id, event id, expiry only; verified in constant time; secret in SSM.
3. **Check-in.** One conditional update `BOOKED` to `CHECKED_IN`.
4. **Idempotent analytics.** Each stream record is applied in one transaction: marker item (`attribute_not_exists`), event counter, per-minute bucket. A replayed record meets the marker and changes nothing. Markers expire after 3 days.
5. **Structured logs and metrics.** JSON logs; custom metrics as Embedded Metric Format lines. A real bug was found and fixed here: with Lambda's JSON log format, `console.log` wrapped the EMF line and no metrics appeared; writing with `process.stdout.write` fixed it (verified: metric sums matched the test output exactly).

## 7. Security

Summarise [06-security.md](06-security.md): roles from token groups, signup cannot select Staff, ownership checks, signed QR, private buckets with CloudFront-only reads, pre-signed upload limited by type, size and 120 s, least-privilege roles, CSP and HSTS headers, secrets only in SSM. Close with the threat table at the end of that file, including what is **not** protected (anyone can become Organizer, copied QR, no WAF, wildcard CSP hosts).

## 8. Testing and results (real numbers)

### 8.1 Test inventory

| Layer | Count | Result | Source |
|---|---|---|---|
| Backend unit tests | 133 (8 files) | all pass | `npm test`, last run 2026-10-05 |
| Frontend unit and component tests | 68 (4 files) | all pass | `npm run frontend:test` |
| Integration: events, roles, images | 27 | 27 pass (4 clean runs after one failed setup) | [stage4-integration.txt] |
| Concurrency (overselling) | 4 tests x 3 runs | 12 of 12 pass | [stage5-concurrency.txt] |
| Integration: QR and check-in | 18 tests x 3 runs | 54 of 54 pass in the clean series (first attempt: runs 1 and 2 failed in setup) | [stage6-checkin.txt] |
| Integration: analytics | 13 | 13 pass on the second attempt (first attempt: 4 failed) | [stage7-analytics.txt] |
| Browser end to end (Playwright, desktop and Pixel 7) | 5 | 5 pass (first attempt 4 of 5) | [stage8-e2e.txt], [stage9-e2e-after-ui-strings.txt] |
| Lint, typecheck | Biome 0 errors (33 warnings); `tsc` clean | pass | `npm run lint`, `npm run typecheck` |

### 8.2 Overselling (Stage 5)

| Scenario | Requests | Result in each of 3 runs |
|---|---|---|
| capacity 5, quantity 1 | 50 parallel | 5 x 201, 45 x 409 |
| capacity 5, quantity 2 | 30 parallel | 2 x 201, 28 x 409 |
| capacity 5, mixed quantities | 40 parallel | 4 x 201 / 36 x 409, then 3 x 201 / 37 x 409, then 4 x 201 / 36 x 409; `sold` never above 5 |

Transaction-conflict retries per run: 8, 15, 15. Slowest booking request: 1939, 1585, 1088 ms (client side). 503 responses: 0. Ticket ids were unique and matched what each buyer read back.

### 8.3 Check-in (Stage 6)

20 simultaneous scans of one ticket: 1 x 200 and 19 x 409 in all 3 runs; p50 / max latency 1174 / 1335, 917 / 1504, 743 / 1061 ms. Different tickets scanned together: all admitted (no false rejections). CloudWatch metrics matched the tests exactly (`CheckInSuccess` 20, `CheckInRejected` 132 over 4 runs).

### 8.4 Analytics (Stage 7)

Replay test: the deployed processor was invoked twice with the same record duplicated inside the batch (4 deliveries); `checkedIn` stayed 1 and the per-minute sum stayed 1; `StreamDuplicateSkipped` rose by 4. 20 simultaneous check-ins on one event: all 200 in 1.8 s, `checkedIn` exactly 20, still 20 after 10 more seconds, DLQ empty. Scan to counter: 316 ms (one measurement; not a distribution). Dashboard response times (client side, n = 20): sequential p50 691 ms and p95 990 ms; analytics endpoint p50 658 ms and p95 735 ms; 20 concurrent dashboard calls p50 784 ms and p95 1690 ms.

### 8.5 Load tests (Stage 9, Artillery, from one laptop)

| Run | Requests | req/s avg (peak) | p50 | p95 | p99 | 429 | 5xx | Data check |
|---|---|---|---|---|---|---|---|---|
| Steady mixed, 136 s [stage9-loadtest-steady.txt] | 2881 | 21.2 (30) | 273 ms | 672 ms | 743 ms | 0 | 0 | 269 sold = 269 successful bookings |
| Mixed spike, about 3x [stage9-loadtest-spike-mixed-run1-did-not-reach-limit.txt] | 1935 | 38.5 (32) | 263 ms | 633 ms | 686 ms | 0 | 0 | 185 = 185 |
| Throttle test, one endpoint at 120 arrivals/s [stage9-loadtest-throttle.txt] | 2500 | 62.4 (50) | 263 ms | 672 ms | 1130 ms | 1162 (46.5 %) | 0 | no bookings |

Server side in all three: 0 Lambda errors, 0 Lambda throttles, 0 DynamoDB throttle events; peak 3 to 6 concurrent Lambdas in the mixed runs, 38 in the throttle run. Honest framing: latency includes the laptop's network; the mixed spike did **not** reach the API limit, because the limit is per method (L36); this is a functional load check, not a capacity test (L38).

### 8.6 Failures and fixes (include these; they show the testing was real)

| What failed | What it was | Record |
|---|---|---|
| Stage 4 first run: 403 in setup | cause **not identified**; likely API route propagation after deploy | [stage4-integration-run0-FAILED-setup.txt] |
| Stage 5: custom metrics missing | Lambda JSON log format wrapped `console.log`; fixed and verified | 05-testing.md |
| Stage 6 runs 1 and 2: 403 in setup | route not yet live; readiness gate extended | [stage6-checkin-first-attempt-FAILED-setup.txt] |
| Stage 7 first attempt: first check-in never counted | likely `LATEST` stream start; **not proven; not fixed (L25)** | [stage7-analytics-first-attempt-FAILED-lost-first-record.txt] |
| Stage 7b: switch to `TRIM_HORIZON` failed and rolled back | Lambda allows one trigger per stream and function; my plan was wrong | [stage7b-fresh-trigger-attempt1-FAILED-replacement-rejected.txt] |
| Stage 8 e2e attempt 1: 4 of 5 | timing mistake in the test | [stage8-e2e-attempt1-FAILED-phone-test-race.txt] |
| Stage 8: UI bugs seen only in screenshots | Menu button on desktop, check-in verdict below the camera, blank phone screenshots; fixed | 05-testing.md |
| Stage 9: API 5xx alarm and dashboard watched an empty metric | renaming the API did not change CloudWatch's `ApiName`; fixed | [stage9-loadtest-steady-run1-api-metrics-missing-wrong-dimension.txt] |

## 9. Monitoring and DevOps

CloudWatch dashboard `ticketing-platform-overview` (13 widgets), four alarms to an SNS topic, custom metrics, 7-day log retention. Verified in AWS: dashboard and alarms exist, all four read OK after the load tests; the alarm-to-SNS action was exercised by forcing one alarm [stage9-alarm-wiring-test.txt]. **Not verified:** e-mail delivery (subscription was unconfirmed) and any alarm firing for a real failure. SAM deploy flow documented in the [README](../README.md). CI/CD: **run green once by manual trigger** ([ci-cd-setup.md](ci-cd-setup.md)).

## 10. Limitations and future work

Top items from [limitations.md](limitations.md) to put in the report:
- **L25 (open):** the stream trigger starts at `LATEST`; one check-in was lost right after the first deploy; cause not proven; a fix attempt failed and nothing was changed.
- L16 no idempotency key on booking; L17 hot event under extreme bursts; L19 Staff not tied to an event; L20 a copied QR works for the first scanner; L36 per-method throttle; L38 small load tests; L40 CI proven only by one manual run; L13 no payment.

Future work: idempotency keys for booking, staff assignments, rotating QR codes, key rotation, sharded counters or a queue per event for very hot events, a reconciliation job, WebSockets for sub-second updates, a WAF and a custom domain, per-user purchase caps, a two-step trigger fix for L25 (awaiting your decision), real-device camera testing.

## 11. Conclusion (draft)

> The platform meets its three core correctness goals in tests against the deployed system: no overselling, one admission per ticket, and counters that are not counted twice. It is serverless end to end, observable through a dashboard and alarms, and documented with its failures and limitations. Open items are one stream-trigger issue (L25), a CI/CD pipeline proven only by one manual run, an unmeasured cost, and an untested camera on a real phone.

## Appendix A: figures and screenshots to include

`docs/screenshots/`: `event-list.png`, `ticket-qr.png`, `scanner-admitted.png`, `scanner-already-used.png`, `dashboard.png`, `phone-event-list.png`, `phone-my-tickets.png` (automated captures from the browser tests). **Missing, you need to capture by hand:** the CloudWatch dashboard, the alarm list, and the AWS console showing the deployed stack. Diagrams: [architecture-diagram.md](architecture-diagram.md).

## Appendix B: where the marks are earned

| Rubric area | Marks | Best evidence |
|---|---|---|
| Objectives | 2 | section 2 table; [01-requirements.md](01-requirements.md) |
| Architecture | 4 | [architecture-diagram.md](architecture-diagram.md), [02-architecture.md](02-architecture.md), [03-data-model.md](03-data-model.md), [decisions.md](decisions.md) |
| Implementation | 4 | sections 6 and 8; the three concurrency, check-in and replay tests |
| Security | 2 | [06-security.md](06-security.md) and its tests |
| Database | 2 | [03-data-model.md](03-data-model.md), transaction design, idempotent counters |
| Deployment and DevOps | 2 | `template.yaml`, README, `sam deploy` history; CI/CD as "run once, manually" |
| Monitoring | 1 | dashboard, alarms, load test results |
| Documentation and presentation | 2 | this folder, [08-presentation.md](08-presentation.md), [demo-guide.md](demo-guide.md) |
| Innovation | 1 | idempotent stream counters with a replay test; signed anonymous QR; live analytics without WebSockets |
