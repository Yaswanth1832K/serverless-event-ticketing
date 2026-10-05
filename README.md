# Serverless Event Ticketing & QR Check-in Platform on AWS

Organizers publish events, attendees book tickets, door staff scan signed QR codes, and organizers watch attendance live. Everything runs on AWS serverless services in **us-east-1**, defined with **AWS SAM** (the only infrastructure tool used).

Three guarantees are enforced by the database, not by application memory, and each one was tested against the deployed stack:

| Guarantee | How | Evidence |
|---|---|---|
| **Never oversell** | one DynamoDB transaction: conditional increment of `sold` plus the ticket items | capacity 5, 50 parallel buyers: exactly 5 succeed, 45 get 409 (3 runs) |
| **A ticket is admitted once** | conditional update `BOOKED` to `CHECKED_IN` | 20 simultaneous scans of one ticket: exactly 1 x 200 and 19 x 409 (3 runs) |
| **Live counters are never counted twice** | DynamoDB Stream, with a per-ticket idempotency marker written in the same transaction as the counters | a replayed batch changed nothing; 20 check-ins gave exactly 20 |

Results and the full list of what is *not* verified: [docs/05-testing.md](docs/05-testing.md) and [docs/unverified-claims.md](docs/unverified-claims.md).

## Architecture in one picture

See [docs/architecture-diagram.md](docs/architecture-diagram.md) (Mermaid) and [docs/02-architecture.md](docs/02-architecture.md).

Browser (React, S3 + CloudFront) → API Gateway (Cognito authorizer) → one Lambda per area → DynamoDB (single table). DynamoDB Streams → stream-processor Lambda → counters and per-minute check-in buckets. QR signing key in SSM Parameter Store. CloudWatch dashboard and four alarms to an SNS topic.

## Repository layout

| Path | What is in it |
|---|---|
| `template.yaml`, `samconfig.toml` | The whole stack (SAM) |
| `backend/functions/` | Lambdas: `events`, `booking`, `tickets`, `checkin`, `analytics`, `stream-processor`, `auth-triggers`, `health` |
| `backend/shared/` | Logging, metrics (EMF), HTTP/CORS, auth, validation, QR signing, DB helpers |
| `frontend/` | Vite + React + TypeScript app, unit tests and Playwright browser tests |
| `tests/` | Unit, integration, concurrency tests (integration and concurrency run against the deployed stack) |
| `loadtest/` | Artillery load tests (own `package.json`) |
| `scripts/` | Deploy-frontend, demo seeding, e2e and load-test runners |
| `ci/`, `.github/workflows/` | CI/CD workflow and AWS role policy templates |
| `docs/` | Requirements, architecture, data model, security, API, testing, decisions, limitations, demo guide, report outline, slides, test outputs |

## Prerequisites

- An AWS account with permission to create the resources in `template.yaml` (CloudFormation, IAM roles, Lambda, API Gateway, DynamoDB, Cognito, S3, CloudFront, SQS, SNS, CloudWatch, SSM), and credentials configured (`aws configure`, region `us-east-1`).
- AWS CLI v2, AWS SAM CLI, Git, and Node.js. Node 22 matches the Lambda runtime. The project was developed on Node 20, which works but makes the AWS SDK print a warning.
- Windows: run `sam` from **PowerShell**, and build with `npm run build` (not plain `sam build`) so the project's own esbuild is found. Commands below are PowerShell; the bash equivalents differ only in the secret step.

## Deploy from scratch

```powershell
# 1. Install
npm ci
npm ci --prefix frontend

# 2. Create the QR signing secret ONCE (random, 32 bytes, never printed, never stored in the repo)
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
aws ssm put-parameter --name /ticketing-platform/qr-signing-secret --type SecureString --value ([Convert]::ToBase64String($b)) --region us-east-1 | Out-Null
Remove-Variable b
```
```bash
# bash equivalent of step 2
aws ssm put-parameter --name /ticketing-platform/qr-signing-secret --type SecureString \
  --value "$(openssl rand -base64 32)" --region us-east-1 > /dev/null
```
```powershell
# 3. Check, build, and review the changeset before anything is created
npm run lint; npm run typecheck; npm test
sam validate --lint --region us-east-1
npm run build
sam deploy --confirm-changeset --parameter-overrides "AlarmEmail=you@example.com"
#   AlarmEmail is optional. Leave it out and the alarms still exist but nobody is e-mailed.
#   Read the changeset, answer y. A first deploy takes several minutes (CloudFront is the slow part).

# 4. Publish the website (builds the app, writes config.json from the stack outputs, uploads, prints the URL)
npm run deploy:frontend

# 5. Optional: demo accounts and one demo event, created through the real API
npm run seed:demo
```

Things to know on a fresh deploy:
- **Confirm the alarm e-mail.** AWS sends a confirmation message to `AlarmEmail`; click the link, or alarms fire silently (L37).
- **API routes can take a minute to go live** after a deploy (a bare 403 "Authorization header requires 'Credential'" means not yet).
- **Wait a few minutes before the first check-ins on a brand-new stack.** The stream trigger starts at `LATEST` and a scan made before its poller attaches can go uncounted (limitation **L25**, open, cause not proven). Existing tickets stay correct; only the live counter can lag.
- The QR secret path is a stack parameter (`QrSecretParamName`). A second stack (for example `ticketing-dev`) needs its own secret and `--stack-name`; see [docs/ci-cd-setup.md](docs/ci-cd-setup.md).

## Run the tests

| Command | What it runs | Needs the deployed stack |
|---|---|---|
| `npm test` | 133 backend unit tests | no |
| `npm run frontend:test` | 68 frontend unit and component tests | no |
| `npm run lint`, `npm run typecheck` | Biome lint, TypeScript | no |
| `npm run test:integration` | every file in `tests/integration/` (events and roles: 27 tests; check-in: 18; analytics: 13) | yes |
| `npm run test:concurrency:x3` | overselling test, 3 full runs, output to `docs/test-results/` | yes |
| `npm run test:checkin:x3` | QR and check-in tests, 3 runs | yes |
| `npm run test:analytics` | analytics and idempotent stream tests | yes |
| `npm run e2e` | Playwright browser tests against the live site (desktop and phone size) | yes, after `deploy:frontend` |
| `npm --prefix loadtest install`, then `npm run loadtest`, `loadtest:spike`, `loadtest:throttle` | Artillery load tests | yes |

Tests that need the stack create their own throw-away users and events and remove them afterwards. `npm run e2e:cleanup` removes leftovers.

## Demo

[docs/demo-guide.md](docs/demo-guide.md): test accounts, a timed 5-minute script, and `npm run demo:reset` for a fresh demo in about 20 seconds.

## Monitoring

Dashboard `ticketing-platform-overview` (CloudWatch): API requests, latency p50/p95/p99 and errors, Lambda errors/duration/throttles, DynamoDB throttles and transaction conflicts, DLQ depth, and the custom metrics `BookingSuccess`, `BookingRejectedSoldOut`, `BookingConflictRetry`, `CheckInSuccess`, `CheckInRejected`, `CheckInCounted`, `StreamDuplicateSkipped`. Alarms: Lambda errors, API 5xx, stream DLQ not empty, DynamoDB throttles. The dashboard link is the `DashboardUrl` stack output.

## Cost and billing safety

The design avoids always-on resources: DynamoDB on-demand, 256 MB Lambdas, 7-day log retention, no NAT gateway, no VPC, no SES. Everything idles at close to zero.

**This was not measured against a real bill.** The statements below are general AWS pricing behaviour that I have not checked against this account; check the Billing console yourself.
- Most of this should fall inside the free tier for a student project, but the free tiers differ by service and some (for example API Gateway's) expire after 12 months for older accounts.
- Things that can cost money if left running or hit hard: CloudFront data transfer, DynamoDB on-demand requests, API Gateway calls, extra CloudWatch dashboards and alarms beyond the free allowance, and the load tests (a few thousand requests per run).
- **Set a budget alert before deploying** (Console: Billing, Budgets, create a monthly cost budget of a few dollars with an e-mail alert). This is manual and is not done by this repository.
- The API Gateway throttle (50 requests/s per method, burst 100) limits each endpoint but does not cap total cost (L36).
- When you are done, **delete the stack** (below). A deleted stack stops all charges for what it created.

## Clean-up

Run in PowerShell. Order matters: the two buckets must be empty or the stack delete fails.

```powershell
$S = 'ticketing-platform'
$out = aws cloudformation describe-stacks --stack-name $S --region us-east-1 --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
$web    = ($out | Where-Object OutputKey -eq 'WebBucketName').OutputValue
$images = ($out | Where-Object OutputKey -eq 'ImagesBucketName').OutputValue

aws s3 rm "s3://$web"    --recursive
aws s3 rm "s3://$images" --recursive
sam delete --stack-name $S --region us-east-1 --no-prompts
aws ssm delete-parameter --name /ticketing-platform/qr-signing-secret --region us-east-1
```

What this removes: the API, Lambdas, DynamoDB table with all data, Cognito user pool with all users, both CloudFront distributions, log groups, alarms, dashboard, SNS topic. CloudFront distributions can take several minutes to disappear.

What it does **not** remove:
- The SAM deployment bucket (stack `aws-sam-cli-managed-default`), shared by every SAM project in the account. Delete it only if nothing else uses it: empty the bucket (it is versioned, so delete all versions in the console), then `aws cloudformation delete-stack --stack-name aws-sam-cli-managed-default`.
- The CI roles and OIDC provider, if you created them (see [docs/ci-cd-setup.md](docs/ci-cd-setup.md)).
- Anything in the AWS Budgets console.

Check: `aws cloudformation describe-stacks --stack-name ticketing-platform` should now report that the stack does not exist.

## API and security

- [docs/api.md](docs/api.md): every route, who may call it, and the error codes.
- [docs/06-security.md](docs/06-security.md): roles, QR design, IAM, headers, and what is not protected.
- [docs/decisions.md](docs/decisions.md) (D1 to D27) and [docs/limitations.md](docs/limitations.md) (L1 to L42).

## Honest status

Built and run against the deployed stack: stages 1 to 9 (events, booking, QR and check-in, analytics, frontend, monitoring, load tests). **Written but never run: the GitHub Actions pipeline** and its AWS role. **Open:** L25 (stream trigger can miss records written before it attaches). **Not tested:** the camera scanner on a real phone, alarm e-mail delivery, a real cost figure. The full list with wording suggestions is in [docs/unverified-claims.md](docs/unverified-claims.md).
