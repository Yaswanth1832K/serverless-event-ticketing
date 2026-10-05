# 08 – Presentation: slides, demo and viva

Numbers are from `docs/test-results/` (see [07-final-report-outline.md](07-final-report-outline.md) for the sources). The 5-minute live script with exact clicks is [demo-guide.md](demo-guide.md); run `npm run demo:reset` before you start.

## 12-slide outline (about 5 minutes of slides plus the demo, or 10 minutes without)

| # | Slide | Content | Say |
|---|---|---|---|
| 1 | Title | Name, team, one-line description | "A ticketing system that cannot oversell and admits each ticket once." |
| 2 | Problem | Forms and spreadsheets: overselling, copied tickets, no live view | "The last five seats are where the bugs are." |
| 3 | Objectives | O1 to O7 with a status mark each (see report outline section 2) | "Six are tested. One, the pipeline, has run green once by manual trigger; the push trigger is not enabled." |
| 4 | Architecture | Diagram 1 from [architecture-diagram.md](architecture-diagram.md) | Follow one request: browser, API Gateway, Lambda, DynamoDB. |
| 5 | Data model | Diagram 2: one table, event and ticket in one partition | "One table, so one transaction can cover the event counter and its tickets." |
| 6 | Overselling protection | The condition `sold <= capacity - n`, one transaction | "The database decides, not the page." Result: 50 buyers, 5 seats: 5 booked, 45 sold out, 3 runs. |
| 7 | QR and check-in | Token format, one conditional update | 20 simultaneous scans: 1 admitted, 19 rejected, 3 runs. "No name or e-mail in the QR." |
| 8 | Live analytics | Stream, idempotency marker, 5 s polling | Replay test: counters unchanged. 20 check-ins counted exactly 20. Lag 316 ms (one measurement). |
| 9 | Security | Roles from token groups, no Staff signup, ownership checks, signed QR, private buckets, headers | "The website only hides menus. The server enforces everything." Show the "not protected" list too. |
| 10 | DevOps and monitoring | SAM, dashboard screenshot, four alarms, load test table | 2881 requests, 0 errors, p95 672 ms from a laptop. One 429 test: 1162 throttled, 0 5xx. |
| 11 | What went wrong | The failures table (report section 8.6) | "We kept the failed runs. The open one is L25: the stream trigger can miss a record right after deploy." |
| 12 | Limitations, future work, thanks | L16, L19, L20, L25, L36, L40; future work list | Unproven items stated plainly. Questions. |

**Screenshots you must still capture by hand** for slides 4 and 10: the CloudWatch dashboard and the stack in the AWS console.

## Demo (5 minutes)

Follow [demo-guide.md](demo-guide.md) section 4. Before you go on stage:
1. `npm run demo:reset` (about 20 seconds).
2. Open the site on a laptop (Organizer) and on a phone (Attendee). **Try the phone camera once beforehand: it has never been tested on a real phone** (L32). If it fails, paste the code instead; that path is tested.
3. Click each page once to avoid a cold-start pause.
4. Have the CloudWatch dashboard open in another tab.

Backup if the live site fails: the saved screenshots in `docs/screenshots/` and the test outputs in `docs/test-results/`.

## Viva questions and honest answers

**Q1. How do you stop two people buying the last ticket?**
A single DynamoDB `TransactWriteItems`: update the event's `sold` with the condition `sold <= capacity - n` (and `capacity` unchanged) and create the ticket items in the same transaction. DynamoDB evaluates the condition atomically against the stored value, so two buyers cannot both pass when one seat is left. Tested with 50 parallel buyers for 5 seats, three times: always exactly 5.

**Q2. Why not just `sold + n <= capacity` in the condition?**
DynamoDB conditions cannot do arithmetic. The function reads the capacity first and sends `capacity - n` as a constant. The read is only a hint; the condition is what guarantees correctness. (An earlier draft of our docs had the invalid form; we corrected it.)

**Q3. What happens when many people hit the same event at once?**
They conflict on one item and DynamoDB cancels some transactions. The function retries those up to 12 times with random delay, and says "sold out" only after a fresh read confirms it. In our tests there were 8 to 16 retries per run and no 503. For extreme bursts on one event a 503 `BUSY` is possible (L17); the fix would be sharded counters or a queue.

**Q4. What if a buyer double-clicks?**
Two requests make two bookings, because there is no idempotency key (L16). Overselling is still impossible. The website disables the button while a request is in flight, which reduces but does not remove it. The fix is an idempotency key.

**Q5. How can a QR code not be forged?**
It holds a ticket id, event id and expiry, signed with HMAC-SHA256 using a secret in SSM Parameter Store that never leaves the server. Changing any character breaks the signature. Eight tampered variants were rejected in tests.

**Q6. What does the QR reveal about the attendee?**
Nothing personal: only ids and an expiry.

**Q7. Can someone copy a QR and use it?**
Yes, the first person to scan it is admitted and the real owner is then rejected (L20). A real system would check identity at the gate or rotate the code frequently.

**Q8. How do you guarantee one admission per ticket with several gates?**
One conditional update, `BOOKED` to `CHECKED_IN`. With 20 simultaneous scans exactly one succeeded, three times.

**Q9. How are live statistics kept correct if the stream delivers a record twice?**
Each record is applied in one transaction with a marker item that can only be created once. A replayed record finds the marker and changes nothing. Tested by replaying a batch against the deployed function.

**Q10. Is the live count always right?**
No. Counters lag by a moment (316 ms in one measurement), and there is an open issue, **L25**: right after the stream trigger was created, one check-in was never delivered, so that counter was one too low. We think it is the `LATEST` starting position but did not prove it, and our attempt to change it failed and was rolled back. The tickets themselves are always correct; only the live counter can be affected, and there is no reconciliation job (L29).

**Q11. Why polling instead of WebSockets?**
For one organizer watching a dashboard, a 5 second delay is fine and polling has far fewer moving parts. WebSockets are future work.

**Q12. How are roles enforced?**
From the Cognito group claim in the verified token on the server, never from anything the client sends. Signup cannot request Staff; a trigger rejects it. Staff are added by an administrator. Hiding a menu is only cosmetic.

**Q13. Can an organizer see or edit another organizer's event?**
No: 403, tested, and the event is unchanged afterwards. But Staff accounts can scan for any event (L19), and anyone can sign up as Organizer (L8).

**Q14. Why DynamoDB and one table?**
Atomic conditional writes and transactions are what make overselling protection simple, and every access pattern here is a key lookup or one query. The cost is that items are harder to read than separate tables.

**Q15. What does it cost?**
We designed it to idle at close to zero (on-demand, no always-on resources), but **we have not looked at a bill**, so we cannot give a number. Set a budget alert and delete the stack when finished (README).

**Q16. How did you test performance?**
Artillery from one laptop: 2881 requests over 136 s at about 21 requests/s on average (30 at peak), no errors, p50 273 ms, p95 672 ms, p99 743 ms, and the database ticket count matched the successful bookings. That includes our network and is not a capacity test (L38). A separate test pushed one endpoint past the API Gateway limit: 1162 of 2500 requests got 429 and there were no 5xx.

**Q17. Did your alarms ever fire?**
Not for a real failure. We forced one alarm and CloudWatch ran its notification action. E-mail delivery was not verified because the subscription needed a confirmation click. A 429 does not trigger the 5xx alarm; a 503 would.

**Q18. Is the CI/CD working?**
Yes, once, started by hand: lint, typecheck, tests and `sam validate` on GitHub, then an automatic deploy to dev, then a deploy to prod that waited for a reviewer's approval, with OIDC and no stored keys. The first run failed because our trust policy had the wrong GitHub subject format, which we fixed. What we have **not** shown: that it triggers on push (that trigger is off for now), a failing deploy, or why one run's prod job stalled for 14 minutes before we cancelled it.

**Q19. What did you get wrong along the way?**
Several things, all documented: a doc formula that was not valid DynamoDB, metrics that did not appear because of the log format, tests that started before routes were live, a wrong plan for changing the stream trigger, UI bugs we only saw in screenshots, and an API rename that left the alarm watching an empty metric. The failed runs are kept in `docs/test-results/`.

**Q20. What would you do next?**
Idempotency keys for booking, staff assigned to events, rotating QR codes, a reconciliation job for counters, the two-step fix for L25, a WAF and custom domain, and real-device camera testing.
