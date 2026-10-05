# Decisions log

| # | Decision | Reason |
|---|---|---|
| D1 | Region **us-east-1**, passed explicitly (`--region`, `samconfig.toml`). The CLI default profile region is not changed. | Set in the project brief. The AWS CLI default on this machine was eu-north-1. |
| D2 | Single DynamoDB table with 2 GSIs | See `03-data-model.md`. |
| D3 | `sold` is updated in the booking transaction. `checkedIn` and the time series are updated by DynamoDB Streams. | `sold` must be exact to enforce capacity. Check-in stats are reporting only. |
| D4 | SQS is used only as the stream processor's DLQ | Gives the failure alarm a real signal. Not added to the main path. |
| D5 | No payments. Booking is treated as paid. | Out of scope for the project. Marked as simplified in the docs. |
| D6 | Signup lets a user choose Attendee or Organizer. Staff is added to the Staff group by an organizer or admin. | Simplest workable demo flow. Open organizer signup would need approval in production. |
| D7 | Dashboard uses 5-second polling, not WebSockets | See the trade-off table in `02-architecture.md`. |
| D8 | Money stored as integer cents | Avoids floating-point errors. |
| D9 | Max 5 tickets per booking request | Keeps the transaction small and limits abuse. |
| D10 | Lambda runtime **nodejs22.x** (brief said Node 20). Local tooling and CI still use Node 20. | AWS deprecated `nodejs20.x` on 2026-04-30 and `sam validate --lint` flags it (W2531). Code targets ES2022 and works on both. |
| D11 | Build with `npm run build` (not bare `sam build`). | `npm run` puts the local `node_modules/.bin/esbuild` on PATH, which SAM's esbuild builder needs. |
| D12 | vitest pinned to 2.x | The newest vitest failed to load its native rolldown binding on this Windows machine. |
| D13 | Cognito sign-up is auto-confirmed (PreSignUp trigger) with no email verification. A PostConfirmation trigger adds the user to Organizer or Attendee from `custom:role`. | Demo simplicity, and avoids depending on email delivery. Production would verify email. The role claim is only trusted for these two groups. |
| D14 | `ALLOW_USER_PASSWORD_AUTH` enabled on the app client. | Lets test scripts log in without SRP. The SPA will use SRP. |
| D15 | API Gateway CORS preflight allows one origin (the `AllowedOrigin` parameter). | API Gateway preflight config accepts a single origin. Lambda responses use the same allowlist check. |
| D16 | The frontend loads its settings from `/config.json` at start-up (runtime config), written from the CloudFormation outputs by `scripts/deploy-frontend.mjs`. | One build works for any deployment and an API change needs no rebuild. The file holds public ids only: no secrets, no AWS credentials. |
| D17 | Sign-in tokens live in `sessionStorage` (memory if storage is blocked), with Cognito's SRP login. | Safer than `localStorage` (cleared when the tab closes). Trade-off in L30. |
| D18 | The site's CORS origin is the CloudFront address, referenced inside the template (no manual second deploy). The old `AllowedOrigin` parameter was removed. Local development uses a Vite proxy. | Removes a manual step and a way to mis-configure CORS. Preflight allows one origin anyway (D15). |
| D19 | The CSP uses wildcard hosts for API Gateway, S3 uploads and image CDN. | An exact list made the template circular (found by `sam validate --lint`). See L31. |
| D20 | `vitest.config.ts` is separate from `vite.config.ts` in the frontend. | Vitest 2 bundles Vite 5, so sharing one config with Vite 6 made the types disagree. |
| D21 | `seed:demo` uses only the real API (plus Cognito's admin call for the Staff account). `seed:demo:clean` deletes demo events straight from DynamoDB. | Events with sold tickets cannot be deleted through the API (by design). The clean step is explicit, separate, and limited to `[DEMO]` events of the demo organizer. |
| D22 | A stream-trigger change to `TRIM_HORIZON` was attempted and failed, and the template is back to `LATEST`. | Lambda allows one trigger per stream and function, so a CloudFormation replacement is rejected. A two-step fix is proposed but not applied (L25). |
| D23 | Monitoring is in `template.yaml`: one SNS topic, four alarms (Lambda errors, API 5xx, DLQ not empty, DynamoDB throttles) and one dashboard. The alarm e-mail is a deploy-time parameter (`AlarmEmail`), not stored in the repo. | The brief asked for at least two alarms and an SNS e-mail. Keeping the address out of the repo avoids publishing a personal address. |
| D24 | The dashboard and 5xx alarm use `ApiName = <stack name>` and the API has no explicit `Name`. | A first attempt renamed the API to `<stack>-api`. The API was renamed but CloudWatch kept reporting under the old name, so the alarm watched nothing. Found because the first load test showed 0 requests counted server-side. Fixed and re-verified (L42). |
| D25 | Load tests use Artillery in its own `loadtest/` package, with users and events created and removed by `scripts/run-loadtest.mjs`. | Artillery is a large install and is kept out of the main project and the CI unit-test job. The runner never touches the demo event or demo accounts, and removes everything it created. |
| D26 | CI/CD: one workflow, jobs `verify` then `deploy-dev` (automatic) then `deploy-prod` (GitHub environment with a required reviewer). Dev and prod are two stacks in the same AWS account and region, with separate OIDC roles. The existing stack `ticketing-platform` is prod. | Matches "dev automatically, prod after manual approval" without a second account. A second account would isolate better but is more setup than this project needs. |
| D27 | Linting is Biome (`npm run lint`), not ESLint. Formatting rules and the non-null-assertion rule are off. | The project uses TypeScript 7 (the native compiler). I did not try ESLint; I assumed typescript-eslint would not work with it (unverified) and chose Biome, which needs no TypeScript compiler API. The rules that remain caught real problems (see 05-testing.md, Stage 9). |
