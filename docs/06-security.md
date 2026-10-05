# 06 – Security

What is protected, how, which test shows it, and what is **not** protected. "Tested" always means run against the deployed stack unless stated. Every limitation referenced here is in [limitations.md](limitations.md).

## 1. Identity and roles

| Control | How it works | Evidence |
|---|---|---|
| Authentication | Cognito user pool. The website signs in with SRP, so the password never leaves the browser in clear. Every API route except `GET /events`, `GET /events/{id}` and `GET /health` has a Cognito authorizer, so API Gateway rejects a missing or invalid token before any Lambda runs. | Stage 4: write routes return 401 with no token and with garbage tokens |
| Role comes from the server | Authorization reads the `cognito:groups` claim of the verified token, never a field sent by the client. | Stage 4 and 8 tests: wrong role gets 403 |
| Signup cannot choose a powerful role | The PreSignUp trigger rejects any requested role other than Attendee, Organizer or none. `Staff` and `Admin` signups are refused by Cognito. The PostConfirmation trigger adds the user to Attendee or Organizer. **Staff exist only if an administrator adds them** to the Staff group. | Stage 4: Staff and Admin signups rejected; the registration form offers only Attendee and Organizer |
| Ownership | An organizer can edit, delete, view analytics for and scan tickets for **their own** events only. The check compares the event's `organizerId` with the token's `sub` on the server. | Stage 4: organizer B gets 403 on edit, delete and image-url for A's event, and A's event is unchanged. Stage 7: another organizer gets 403 on analytics. Stage 6: a non-owning organizer gets 403 on scan |
| Own data only | A user can fetch the QR of **their own** ticket. Someone else's ticket gives the same 404 as a ticket that does not exist, so ticket ids cannot be probed. | Stage 6: 4 non-owners get 404 and no token |

Not protected: anyone can register as Organizer (L8); signup is auto-confirmed with no e-mail verification (L7, D13); Staff are not tied to an event, so any Staff account can scan any event (L19); `ALLOW_USER_PASSWORD_AUTH` is enabled so scripts can log in (L9); a 403 on another organizer's event confirms that it exists (L10).

## 2. QR codes and check-in

- **Token format:** `v1.<payload>.<signature>`. The payload holds only the ticket id, the event id and an expiry. **No name, no e-mail.** The signature is HMAC-SHA256 with a key of at least 32 random bytes held in SSM Parameter Store as a SecureString. The key is generated on the machine, never printed, never written to the repo, and cached in a warm Lambda for 5 minutes.
- **Verification order:** signature (constant-time comparison), then structure, then expiry. Expiry is 24 hours after the event's current start time.
- **Admission:** one conditional update, `status = BOOKED` to `CHECKED_IN`. DynamoDB evaluates it atomically, so of any number of simultaneous scans exactly one wins.
- **Logging:** the check-in function logs the rejection reason, never the token.
- **Tested (3 clean runs):** 8 tampered or forged variants all rejected with `INVALID_TOKEN`; expired token `TOKEN_EXPIRED`; another event's token `WRONG_EVENT`; a signed token for a ticket that does not exist `TICKET_NOT_FOUND`; 20 simultaneous scans of one ticket gave 1 x 200 and 19 x 409 in every run; no ticket changed after a rejected scan. A search of the check-in and tickets logs for the start of every encoded token (`eyJ`) found 0 lines, with positive controls showing the search works.

Not protected: a copied QR admits whoever scans first (L20); there is no key rotation (L21); a check-in cannot be undone (L24).

## 3. Overselling and data integrity

- Booking is one `TransactWriteItems`: a conditional increment of `sold` on the event (`sold <= capacity - n`, with `capacity` also checked) plus one Put per ticket with `attribute_not_exists`. All or nothing.
- The client cannot set `sold`, `checkedIn`, `organizerId` or any ticket field. Forged values in the request body are ignored (tested in Stage 4).
- Counters are changed only by the booking transaction (`sold`) and the stream processor (`checkedIn`), and the stream processor is idempotent (a per-ticket marker in the same transaction). Tested: a replayed batch changed no counter; 20 check-ins gave exactly 20.

## 4. Input validation

Every endpoint validates its input before touching data: JSON object only, request body size limit, string lengths, no control characters in names, integer ranges for price, capacity and quantity (1 to 5 per booking), start time in the future, and a UUID format for ids (a malformed id is a 404, not an error leak). Stage 4 tests 400 for missing fields, zero capacity, negative price, past date, oversized name, a string capacity and non-JSON bodies. Error responses carry a code and a plain message, never a stack trace (unhandled errors return a generic 500 and are logged).

## 5. Images

- The images bucket is private with Block Public Access on and encryption at rest. It can be read only through CloudFront (Origin Access Control).
- Upload uses a **pre-signed POST** that expires in about 120 seconds, is limited to JPEG, PNG and WebP, a maximum of 2 MB, and a key under that event's own prefix `events/<eventId>/`. Tested: a wrong content type is refused by S3 (403), a file over 2 MB is refused by S3 (400), a foreign `imageKey` is rejected, the direct S3 URL returns 403, HTTP redirects to HTTPS.
- Bucket policies deny any non-HTTPS request.

Not protected: the file content is not scanned or re-encoded (a file can claim to be a PNG and not be one, apart from the type S3 enforces on upload); images are public to anyone who has the URL; no cleanup of unused images (L1); no check that an uploaded image exists (L2).

## 6. Least-privilege IAM

| Function | Allowed (from `template.yaml`) |
|---|---|
| events | DynamoDB Get, Put, Update, Delete, Query on the table; `s3:PutObject` on `events/*` of the images bucket only |
| booking | DynamoDB Get, Put, Update on the table |
| tickets | DynamoDB Query on index GSI1, GetItem on the table; `ssm:GetParameter` on the QR secret path only |
| checkin | DynamoDB GetItem, UpdateItem; `ssm:GetParameter` on the QR secret path only |
| analytics | DynamoDB GetItem, Query (table and GSI1), read only |
| stream-processor | Own explicit role: DescribeStream, GetRecords, GetShardIterator on **this** table's stream; PutItem, UpdateItem on the table; `sqs:SendMessage` on the DLQ. `dynamodb:ListStreams` is the one wildcard because AWS cannot restrict it by resource |
| auth-triggers | `cognito-idp:AdminAddUserToGroup` on user pools in this account and region (a specific pool ARN would make the template circular) |

No function has `Scan`, `BatchWrite` or any `*` action. Tests do not assert these policies; they were read from the template.

## 7. Network and browser

- HTTPS only. CloudFront redirects HTTP to HTTPS (tested), and API Gateway is HTTPS only.
- Response headers on every page, set by a CloudFront response headers policy (tested): Content-Security-Policy (`default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`), HSTS for one year with subdomains, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, and a Permissions-Policy that allows only the camera.
- CORS on the API and the images bucket allows only the website's own CloudFront address.
- `config.json` served to the browser has exactly 5 public keys (API URL, region, user pool id, client id, images URL) and no secret (tested).

Not protected: the CSP uses wildcards for the API Gateway, S3 and CloudFront hosts and allows inline styles (L31); the default `*.cloudfront.net` certificate means AWS chooses the minimum TLS version (L11); tokens live in `sessionStorage`, readable by any script on the page if an XSS bug existed (L30). **There is no WAF, no bot protection, and no per-user rate limit.** The API Gateway throttle is per method (L36).

## 8. Secrets and credentials

- The QR signing key exists only in SSM (SecureString). It is created once with the AWS CLI and is a stack **parameter name**, not a value.
- No AWS access key or password is in the repository, the frontend or the template. The frontend holds only Cognito public ids and the signed-in user's own token.
- The demo accounts use the throw-away password in [demo-guide.md](demo-guide.md). That is deliberate demo data on this project's own pool and must not be reused.
- Scripts that talk to AWS use the developer's own credentials. The load-test and e2e runners generate random passwords per run, keep them in memory, and delete the users afterwards.
- CI uses OIDC role assumption with no stored keys. **This has never run** ([ci-cd-setup.md](ci-cd-setup.md), L40), and the deploy role is broad (L41).

## 9. Detection and response

Four alarms (Lambda errors, API 5xx, stream DLQ not empty, DynamoDB throttles) go to an SNS topic. The alarm-to-SNS wiring was tested by forcing one alarm. E-mail delivery was not (L37). No alarm has fired for a real failure. `CheckInRejected` and the structured JSON logs show scan abuse (L23: it does not count role failures).

## 10. Threat summary

| Threat | Mitigation | Residual risk |
|---|---|---|
| Overselling by a burst of buyers | Atomic transaction | Hot event can return 503 BUSY under extreme bursts (L17) |
| Double entry on one ticket | Conditional update | Shared screenshot works for the first scanner (L20) |
| Forged or edited QR | HMAC signature, constant-time check | Key leak means manual rotation (L21) |
| Privilege escalation at signup | PreSignUp trigger, group-based roles | Anyone can become Organizer (L8) |
| Reading or editing another organizer's data | Server-side ownership checks | Staff can scan any event (L19) |
| Abuse of upload | Type, size, prefix, short expiry | No content scan, no cleanup (L1, L2) |
| Cross-site scripting | React escaping, strict CSP | Wildcard hosts and inline styles (L31), token in `sessionStorage` (L30) |
| Request floods | API Gateway throttle per method | No total cap, no WAF (L36) |
| Counter drift | Idempotent stream, DLQ alarm | A record missed before the trigger attaches (L25, open), no reconciliation job (L29) |
