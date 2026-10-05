# Demo guide

A 5-minute live demo of the Event Ticketing platform, with the exact clicks, what to say, and how to reset between runs.

## 1. Test accounts

All demo accounts use the password **`DemoPass123`**. They are created by `npm run seed:demo` and are throw-away accounts on this project's own Cognito pool. Do not reuse a real password anywhere here.

| Email | Role (Cognito group) | What it is for in the demo |
|---|---|---|
| `demo.organizer@example.com` | **Organizer** | Owns the demo event. Sees the dashboard, edits the event, scans tickets at the door. |
| `demo.attendee1@example.com` | **Attendee** | Booked 2 tickets. Both are already checked in. |
| `demo.attendee2@example.com` | **Attendee** | Booked 3 tickets. 1 is checked in, **2 are not yet scanned**. |
| `demo.attendee3@example.com` | **Attendee** | Booked 1 ticket (not scanned). **Use this one for the live booking.** |
| `demo.staff@example.com` | **Staff** | Door staff. Can only use the check-in page. |

How roles work, if you are asked:
- Anyone can sign up as **Attendee** or **Organizer** from the sign-up page. **Staff cannot sign themselves up.** An administrator adds them to the Staff group (the seed script does this with Cognito's admin call, using your AWS credentials).
- The website only hides menus. **The server enforces every permission**, so a hand-typed URL or a copied token still gets "403".
- The browser test accounts are named `e2e-…@example.com` and are removed automatically after each test run.

### The demo event after seeding
**[DEMO] Campus Tech Fest**: capacity 10, **6 sold, 4 left**, **3 checked in** (50 % attendance). It has a picture. Three tickets are still unscanned, so you can scan live.

## 2. Setup (do this once, ahead of time)

```bash
sam build && sam deploy            # the stack, including the website bucket and CloudFront
npm run deploy:frontend            # builds the app, uploads it, prints the website address
npm run seed:demo                  # accounts + the demo event (about 20 seconds)
```

Open the website address in two places:
- **Laptop**: the Organizer (browser window 1).
- **Phone** (or a second window): the Attendee. The camera scanner needs the phone and a secure page, which the CloudFront address is.

## 3. Reset between runs (about 20 seconds)

```bash
npm run demo:reset
```

This removes the old demo event and creates a fresh one with the same numbers, through the real API. See "What `demo:reset` touches" below for the one thing it does directly in the database.

## 4. The 5-minute script

| Time | Do this | Say this |
|---|---|---|
| 0:00 | **Not signed in.** Open the site. The event list shows **[DEMO] Campus Tech Fest** with its picture and "4 tickets left". Open it. | "Anyone can browse. The page is a React app on S3 and CloudFront. Every call goes to API Gateway and Lambda." |
| 0:45 | Click **Sign in**. Use `demo.attendee3@example.com`. On the event, click **Book tickets**, choose **2**, press **Book 2 tickets**. | "Booking uses a DynamoDB transaction. The count of sold tickets can never pass the capacity, even if many people press the button at once. I tested 50 at once for 5 seats." |
| 1:30 | Press **Go to My tickets**, then **Show QR code** on a ticket. Open "QR code won't scan?" and point at the code. | "The QR holds only a ticket number and an expiry, signed with a secret from Parameter Store. No name, no email. A copied or edited code is rejected." |
| 2:15 | On the **laptop**, sign in as `demo.organizer@example.com`. Open **Dashboard**. | "Sold went from 6 to 8, so attendance is 3 of 8, **37.5 %**. This page asks again every 5 seconds. I chose that over WebSockets because it is simpler and good enough for one organizer." |
| 3:00 | Open **Check-in**. Pick the event. **Start camera** on the phone and scan the attendee's QR. (No camera? Paste the code.) A green **Checked in** appears. | "The check-in is one conditional update: BOOKED to CHECKED_IN. Only one scan can win." |
| 3:30 | Scan **the same QR again**. A red **Already used** appears, with the time of the first scan. | "I scanned the same ticket from 20 devices at once in testing. Exactly one succeeded." |
| 3:50 | Back on the **Dashboard**. Within about 5–10 seconds checked-in goes up and the chart shows the new check-in. | "A DynamoDB Stream feeds a Lambda that updates the counters. It uses an idempotency marker, so a repeated stream record cannot count twice." |
| 4:20 | Sign in on the phone as `demo.attendee3@example.com`, open the event, book the **last 2 tickets**. The event now says **Sold out**. | "Nothing else could have taken them. Sold out is decided by the database, not by the page." |
| 4:40 | While signed in as that attendee, type `/organizer` in the address bar. | "Permissions are checked on the server. This account gets a plain refusal, and the API would answer 403 even if I forced the call." |
| 5:00 | Done. | |

Optional extras if there is time: sign in as `demo.staff@example.com` (the menu shows only Events and Check-in); open **New event** to show the form checks and the picture upload (JPEG, PNG or WebP, up to 2 MB).

## 5. If something looks wrong

| Symptom | What is happening | Fix |
|---|---|---|
| "My tickets" is empty right after booking | The list is read from an index that catches up in about a second. | Press **Refresh**. |
| The checked-in number does not move at once | The counter is updated by a stream. Normally under a second, but the dashboard only asks every 5 s. | Wait up to 10 s, or press **Refresh now**. |
| The camera will not start | The browser needs permission, and a secure page. | Allow the camera for the site, or use the code box (it always works). |
| "Your session has ended" | The sign-in expired (about an hour). | Sign in again. |
| The seed says a demo event already exists | You ran `seed:demo` twice. | `npm run demo:reset`. |
| The site shows "The app can't start" | `config.json` is missing or damaged. | Run `npm run deploy:frontend` again. |
| First request after a long pause is slow (a second or two) | Lambda cold start. | Click once before you present. |

## 6. What `demo:reset` touches

- **Seeding** (`npm run seed:demo`) uses **only the real API**: Cognito sign-up and sign-in, then the same HTTP calls the website makes (create event, upload picture, book, fetch QR, check in). The one exception is adding the Staff account to its group, which uses Cognito's admin call with your AWS credentials, because staff cannot sign up themselves.
- **Cleaning** (`npm run seed:demo:clean`, the first half of `demo:reset`) is different. An event that has sold tickets **cannot be deleted through the API**, so it deletes the demo event's records **straight from DynamoDB with your AWS credentials**. It only touches events whose name starts with `[DEMO]` and which belong to the demo organizer.
- Neither removes the demo accounts. To delete them after the demo:
  ```bash
  for u in organizer attendee1 attendee2 attendee3 staff; do
    aws cognito-idp admin-delete-user --region us-east-1 --user-pool-id <UserPoolId> --username demo.$u@example.com
  done
  ```
  (`<UserPoolId>` is in the stack outputs: `aws cloudformation describe-stacks --stack-name ticketing-platform --query "Stacks[0].Outputs"`.)

## 7. Honest notes for questions

- **No payment**: price is stored and shown, and booking is treated as paid. This is a stated simplification.
- **Tickets are in-app only** (no email), by design.
- **A copied QR works for whoever scans first** (limitation L20). A real system would also check who is holding it.
- **Staff are not tied to one event** (limitation L19). Any staff account can check people into any event.
- **The stream trigger starts at `LATEST`** and lost one check-in after the first deploy (limitation L25). That is documented and not yet fixed.
- The full list is in [limitations.md](limitations.md).
