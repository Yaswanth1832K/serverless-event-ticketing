# Unverified claims: what to word carefully in the report

Everything below is in the documents or the code but was **not run, not observed, or not proven**. Use the right-hand column as wording. Anything not listed here was run against the deployed stack or locally, and its output is in `docs/test-results/` or was shown at the time (unit tests, lint, typecheck and `sam validate` are re-run on demand).

"Written, not verified" = the artifact exists but has never been executed for real. "Not measured" = nobody looked. "Cause not proven" = we saw the effect and have a theory.

## A. Written, not verified (never executed)

| # | Claim or artifact | Where | Status | Suggested wording |
|---|---|---|---|---|
| A1 | **The GitHub Actions pipeline** (lint, typecheck, tests, `sam validate`, dev deploy, prod deploy with approval) | `.github/workflows/ci-cd.yml`, [ci-cd-setup.md](ci-cd-setup.md), L40, report O7 | Never ran on GitHub. The YAML parses; each step was run separately on a laptop; there is no git repository yet. | "A CI/CD pipeline is defined; it has not yet been run." Do not write "automated deployment" as a result. |
| A2 | **OIDC role, trust policy and permission policy** | `ci/*.template.json`, ci-cd-setup.md, L41 | The JSON parses. The role was never created or assumed; the permission list was written from the template and will probably need additions. | "Role templates are provided; untested." |
| A3 | **GitHub setup commands** (environments, required reviewer, variables) and the **dev stack `ticketing-dev`** | ci-cd-setup.md | Commands never run. A second stack from this template has never been deployed; only `ticketing-platform` exists. Required reviewers on a private repo need a paid plan (from my knowledge, not checked). | "Setup steps are documented, not executed." |
| A4 | **"Deploy from scratch" in the README** | README | The commands were assembled from what was run during development, but the whole sequence has **never been run on an empty account**. The stack was created in Stage 3 and changed in place afterwards. `sam deploy --confirm-changeset`, the bash secret command and the first-deploy timing are untested as written. | "Deployment steps are documented; the stack was built incrementally and has not been recreated from zero." |
| A5 | **The clean-up procedure** (empty buckets, `sam delete`, delete the SSM parameter) | README, ci-cd-setup.md | **Never run.** The stack still exists. Whether `sam delete` finishes cleanly, and how long CloudFront takes, is unknown. | "A clean-up procedure is documented but has not been executed." Run it once at the very end if you want to be able to say otherwise. |
| A6 | ~~Mermaid diagrams~~ **Closed** | architecture-diagram.md, 02-architecture.md | All 6 diagrams were rendered with mermaid-cli and looked at. One real syntax error was found and fixed (the ER diagram used `PK` and `SK` as attribute names, which that notation reserves). PNGs are in `docs/diagrams/`. Rendered with mermaid-cli, not checked in GitHub's own renderer. | Safe to say the diagrams render. |

## B. Not measured or never observed

| # | Claim | Where | Status | Suggested wording |
|---|---|---|---|---|
| B1 | **"Stays within the free tier" / "costs almost nothing when idle"** (objective O6) | requirements, README | The design avoids always-on resources. **Nobody looked at the AWS bill or Cost Explorer.** | "Designed to use pay-per-use services; actual cost was not measured." |
| B2 | **Alarm e-mails reach you** | L37, 05-testing | The alarm-to-SNS action ran when one alarm was forced. The e-mail subscription was `PendingConfirmation`, so delivery is unproven. | "Alarms publish to an SNS topic; e-mail delivery was not confirmed." |
| B3 | **An alarm firing for a real failure** (5xx, Lambda error, DLQ message) | 05-testing | No real failure occurred during any test. The `api-5xx` path via a 503 BUSY was never produced. | "No alarm fired during testing, which was the expected result; fault injection was not performed." |
| B4 | **The camera scanner on a real phone** | L32, demo-guide | Headless Chromium has no camera. The typed-code path and scanner states are tested. | "QR scanning by camera was not tested on a physical device; manual code entry was tested." |
| B5 | **Every dashboard widget shows data** | 05-testing | The dashboard exists (13 widgets). After the API-name fix I did not open the console to look at each chart. The `"..."` metric shorthand in the widgets was not checked visually. | "A dashboard is defined and deployed; screenshot it before the demo." Capture the screenshot yourself. |
| B6 | **Idempotency markers expire after 3 days** (TTL) | 03-data-model, 06-security | The `ttl` attribute is set and TTL is enabled; **expiry was never observed** (DynamoDB deletes asynchronously, often after days). | "Markers carry a 3-day TTL." Do not claim it was observed. |
| B7 | **Server-side latency** | load test files | Only client-side latency (from a laptop) was reported. CloudWatch API Gateway `Latency` was not collected. | Say "measured from the client". |
| B8 | **Demo timings and expected numbers** | demo-guide | The 5-minute script was built from the tested flow and the Playwright journey, but **no human has rehearsed it end to end** on the deployed site with a phone. | "Estimated timings." Rehearse once. |

## C. Cause not proven

| # | Observation | Where | Theory (not proven) | Suggested wording |
|---|---|---|---|---|
| C1 | **L25: the first check-in after trigger creation was never counted** | L25, 05-testing Stage 7, D22 | The stream trigger starts at `LATEST`; records before its poller attaches are skipped. | "One record was lost once; the likely cause is the trigger's starting position; this is unresolved and the fix attempt failed." **Do not say it is fixed or understood.** |
| C2 | **Stage 4 first-run 403 in test setup** | 05-testing Stage 4 | API Gateway route propagation after the deploy. The response body was not captured then. | "Observed once; cause not identified." |
| C3 | **The Stage 6 readiness fix** | 05-testing Stage 6 | The fix could not be re-proven on a fresh deploy (routes were already live). It probably also explains C2. | "Believed to be route propagation." |
| C4 | **Choosing Biome because ESLint would not work with TypeScript 7** | D27 | I never tried ESLint. | "Biome was chosen." Do not give the TypeScript-7 reason as fact. |
| C5 | **The 429s in the throttle test are the per-method limit** | L36 | Strongly supported (mixed traffic spread over six methods never throttled; one method did at 120 arrivals/s), but I did not read AWS documentation to confirm the per-method wording. | "Observed: throttling occurred only when traffic concentrated on one method." |

## D. Narrow evidence: true, but small

| # | Claim | Limit of the evidence |
|---|---|---|
| D1 | "Scan to counter in 316 ms" | One measurement in one run. Not a distribution. |
| D2 | Load test results | One laptop, home or campus network, 8 attendee identities, 5 events, a few hundred tickets, runs of 40 to 136 seconds (L38). Not a capacity or soak test. The mixed spike did not reach the API limit. |
| D3 | "Nothing lost or double-counted under load" | True for tickets sold versus bookings in the steady and mixed-spike runs. **Check-in counters were not exercised under load**; the Stage 7 tests cover them with 20 scans. |
| D4 | Hot event | 50 parallel buyers on one event (Stage 5). Larger bursts are untested (L17). |
| D5 | ~~Stage 4 to 7 integration suites after the last deploy~~ **Closed** | Re-run on the final deployment on 2026-10-05: events 27/27, concurrency 12/12, check-in 54/54, analytics 13/13, e2e 5/5, no failures (see 05-testing.md, "Final re-run"). If anything is deployed again, this is open again. |
| D6 | "Least-privilege IAM" | Read from `template.yaml`. No test tries a forbidden action. The deploy role for CI is broad (L41). |
| D7 | "Bucket policies deny non-HTTPS" and "HTTPS only" | The CloudFront redirect from HTTP to HTTPS was tested. The S3 deny-insecure-transport statements exist in the template but were not tested. |
| D8 | "No token in the logs" | Searched in the check-in and tickets logs only, in Stage 6 (0 hits, with positive controls). Other functions were not searched. |
| D9 | Security overall | No penetration test, no scanner, no XSS test. Claims are about what the code and tests show. |
| D10 | Browsers | Chromium on desktop and an emulated Pixel 7 only. No Safari, Firefox or real phone. Accessibility was checked by lint rules and a few tests, not by a screen-reader pass. |
| D11 | Unit-test coverage | 133 + 68 tests pass; coverage was not measured. |

## E. Statements that are general, not researched

| # | Statement | Where | Note |
|---|---|---|---|
| E1 | "Existing approaches" (forms, spreadsheets, server-based apps) | 07 report outline section 3, requirements | General description. No products, papers or prices were looked up or cited. Add references. |
| E2 | General AWS pricing and free-tier remarks | README cost section | Written from general knowledge; not checked against current pricing pages. |
| E3 | Who built which module | report outline section 5 | The repository does not record authorship; fill it in yourselves. |

## Quick decision list for the report

1. Never write: "CI/CD pipeline deploys automatically", "stays in the free tier", "alarms notify by e-mail", "L25 is fixed", "tested on a phone camera".
2. Safe to write, with the numbers from `docs/test-results/`: no overselling in 3 of 3 runs; one admission per ticket in 3 of 3 runs; idempotent counters (replay test); load test of about 2,900 requests with 0 errors; failed runs kept.
3. If you want fewer caveats, these are cheap to close: confirm the SNS e-mail (B2); capture the dashboard screenshot (B5); rehearse the demo with a phone (B4, B8); run the clean-up procedure at the end (A5); look at the Billing page (B1); push the repo and run the pipeline once (A1 to A3); re-run the integration suites on the final deployment (D5). Any of these will change a "not verified" into a result; do them only when you are ready, since some of them (the pipeline, clean-up) create or delete AWS resources.
