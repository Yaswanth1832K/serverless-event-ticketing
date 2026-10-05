# 01 – Requirements

**Project:** Serverless Event Ticketing & QR Check-in Platform on AWS with Overselling Protection and Live Attendance Analytics

## 1. Problem statement

Small and mid-size event organizers (college fests, workshops, meetups) usually sell tickets through spreadsheets, forms or chat groups. This causes three recurring problems:

1. **Overselling.** When many people book the last few seats at the same moment, a naive "read count, then write count" flow lets more tickets be sold than the venue holds.
2. **Fraud and duplicate entry.** Paper or screenshot tickets can be copied. Two gates can admit the same ticket.
3. **No live visibility.** Organizers only learn how many people showed up after the event.

Traditional servers must be sized for peak demand (a ticket drop lasts minutes) and then sit idle. A serverless design scales to the burst and costs almost nothing when idle.

## 2. Objectives

| # | Objective | How we will show it is met |
|---|-----------|----------------------------|
| O1 | Never sell more tickets than capacity, even under concurrency | Concurrent test: capacity 5, 50 parallel bookings, exactly 5 succeed |
| O2 | Each ticket can be admitted exactly once | Duplicate and parallel scan tests: exactly one check-in succeeds |
| O3 | QR codes carry no personal data and cannot be forged | Signed token (ticket ID + expiry); tamper test |
| O4 | Organizers see attendance in near real time | Dashboard polling backed by DynamoDB Streams counters |
| O5 | Role-based access (Organizer, Attendee, Staff) with ownership checks | Authorization tests (403 on wrong role or wrong owner) |
| O6 | Run entirely on AWS serverless services inside the free tier | SAM template, no always-on resources, cleanup guide |
| O7 | Reproducible deploy and basic observability | `sam deploy`, GitHub Actions, CloudWatch dashboard and alarms |

## 3. Roles

| Role | Cognito group | Capabilities |
|------|---------------|--------------|
| Attendee | `Attendee` | Browse events, book tickets, view own tickets and QR |
| Organizer | `Organizer` | Create, edit and delete **own** events; view dashboard and analytics for own events; scan QR codes for own events |
| Staff | `Staff` | Scan QR codes at the venue (check-in only) |

Self-registration creates Attendees. Organizer and Staff are assigned through Cognito groups. How a user becomes an Organizer is a decision recorded in `decisions.md` (planned: a signup choice limited to Attendee/Organizer; Staff added by an organizer or admin).

## 4. Functional requirements

**Accounts**
- FR1. Register, log in and log out (Cognito).
- FR2. Role is derived from the Cognito group in the JWT, never from a client-supplied field.

**Events (Organizer)**
- FR3. Create an event with name, description, venue, date/time, ticket price, max capacity and image (uploaded to S3 via a pre-signed URL).
- FR4. Edit and delete own events only. Capacity may not be reduced below tickets already sold.
- FR5. List own events.

**Browsing and booking (Attendee)**
- FR6. Browse upcoming events and view details, including remaining tickets.
- FR7. Book 1..N tickets (N capped, for example 5) for an event. A booking fails cleanly with "sold out" when capacity is insufficient.
- FR8. "My Tickets" lists the attendee's tickets with status.
- FR9. View and download a ticket with a QR code.

**Check-in (Staff/Organizer)**
- FR10. Scan a QR code (camera) or paste the token (manual fallback).
- FR11. Valid and unused ticket is checked in. Used, invalid, expired or wrong-event tickets are rejected with a reason.

**Analytics (Organizer)**
- FR12. Dashboard: total events, tickets sold, remaining, checked in, attendance %, check-ins over time, event-wise sales.
- FR13. Updates within a few seconds (polling).

**Delivery**
- FR14. Tickets are delivered in-app only. SES/email is out of scope.

## 5. Non-functional requirements

| Area | Requirement |
|------|-------------|
| Correctness | Sold count never exceeds capacity. A ticket is checked in at most once. Enforced in the database, not in application memory. |
| Scalability | No fixed servers. Lambda and DynamoDB on-demand scale with traffic. |
| Security | Least-privilege IAM (one role per function), input validation on every endpoint, CORS allowlist, HTTPS only, S3 Block Public Access, secrets in SSM Parameter Store. |
| Performance | Typical API response under ~500 ms warm. The load test reports real p95. |
| Availability | Managed multi-AZ services only. |
| Cost | Stay in the AWS free tier. On-demand DynamoDB, 128–256 MB Lambdas, no NAT gateway. |
| Observability | Structured JSON logs, custom metrics, dashboard, at least two alarms. |
| Maintainability | Single IaC tool (SAM), TypeScript throughout, CI on every push. |
| Usability | Responsive UI, no dead buttons. |

## 6. Scope

**In scope:** everything in sections 3–5.

**Out of scope or simplified (will be marked in later docs):**
- Payment processing. Price is stored and shown, and booking is treated as paid. No gateway.
- Email or SMS delivery (SES not used).
- Refunds, waitlists, seat maps.
- WebSockets. We poll instead (trade-off documented in the analytics docs).
- Custom domain and WAF.

## 7. Key challenges and planned approach

| Challenge | Approach |
|-----------|----------|
| Concurrent booking of the last tickets | One DynamoDB `TransactWriteItems`: conditional increment of `sold` on the event (`sold + :n <= capacity`) plus creation of ticket items. If the condition fails, nothing is written. |
| Double scan of one QR | Conditional update `status = BOOKED` to `CHECKED_IN`. The loser gets `ConditionalCheckFailed` and is reported as already used. |
| QR forgery and privacy | The token holds only a ticket ID, event ID and expiry, signed with HMAC-SHA256. The key is stored in SSM and never sent to the client. |
| Live analytics without extra complexity | DynamoDB Streams to one Lambda that maintains per-event counters and per-minute check-in buckets. Dashboard endpoints read the counters. |
| Staying in the free tier | On-demand billing, small Lambdas, short log retention, and a documented cleanup procedure. |
| Limited IAM permissions on the student account | Pre-flight checks. Any permission failure is reported with the exact missing action. |

## 8. Assumptions

- A single AWS region (**us-east-1**) and a single deployed stage.
- Approximate demo scale: tens of events and hundreds of tickets, with load tests up to a few hundred requests.
- Users have a modern browser. Camera scanning needs HTTPS (provided by CloudFront) and camera permission, and manual token entry is the fallback.
