# Architecture diagrams (final)

These show the system **as deployed** in stack `ticketing-platform`, us-east-1. The sequence diagrams for booking and check-in are in [02-architecture.md](02-architecture.md). Mermaid renders on GitHub and in VS Code with a Mermaid extension. PNG renders of every diagram are in [diagrams/](diagrams/) (made with mermaid-cli; see the README there).

## Final architecture (presentation version)

![Architecture of the event ticketing platform: client, edge, API, compute and data layers, a teal analytics stream path, a monitoring strip and a delivery strip](diagrams/architecture-clean.png)

Vector version: [diagrams/architecture-clean.svg](diagrams/architecture-clean.svg). Regenerate both with `node scripts/render-architecture.mjs`.

How to read it, and where each box comes from in `template.yaml`:
- **Request path (dark arrows), left to right:** Browser, then CloudFront + S3 (website and images, `WebDistribution`, `WebBucket`, `ImagesDistribution`, `ImagesBucket`), then API Gateway (`Api`, stage `prod`, Cognito authorizer), then the six API Lambdas (`HealthFunction`, `EventsFunction`, `BookingFunction`, `TicketsFunction`, `CheckinFunction`, `AnalyticsFunction`), then the DynamoDB table (`TicketingTable`, `GSI1`, `GSI2`, Streams, TTL).
- **Sign-in:** the browser talks to the Cognito user pool (`UserPool`, groups `OrganizerGroup`, `AttendeeGroup`, `StaffGroup`), whose triggers are `AuthTriggersFunction`. The user pool is also what the API authorizer checks tokens against.
- **Orange dots:** only `tickets` and `checkin` have permission to read the QR signing key (`ssm:GetParameter` in their policies). **The SSM parameter itself is not in the template**: it is created once with the AWS CLI and only its name is a stack parameter.
- **Teal path (second path):** DynamoDB Streams feed `StreamProcessorFunction`, which writes the counters and per-minute buckets back to the table; failed batches go to `StreamDeadLetterQueue`.
- **Monitoring strip:** one arrow from the Lambda group to CloudWatch (logs, metrics, `OverviewDashboard`), then the four alarms, then `AlarmTopic` (SNS e-mail). The alarms also watch API Gateway, DynamoDB and the dead-letter queue, which the picture does not draw, to keep it readable.
- **Delivery strip (dashed, outside the template):** GitHub Actions with OIDC deploys through CloudFormation (SAM) to the two stacks, `ticketing-platform` and `ticketing-dev`.

The three older diagrams below show more detail (every Lambda, the data model, the delivery flow) and are kept as they were.

## 1. System overview

```mermaid
flowchart TB
    subgraph Client
        U["Browser<br/>React + TypeScript SPA"]
    end

    subgraph Edge
        CFW["CloudFront website<br/>security headers, HTTPS only"]
        CFI["CloudFront event images"]
        S3W[("S3 website bucket<br/>private, OAC")]
        S3I[("S3 images bucket<br/>private, OAC")]
    end

    subgraph Auth
        COG["Cognito user pool<br/>groups: Organizer, Attendee, Staff"]
        AT["Lambda: auth-triggers<br/>PreSignUp, PostConfirmation<br/>rejects Staff signup"]
    end

    subgraph API["API layer"]
        APIGW["API Gateway REST, stage prod<br/>Cognito authorizer<br/>50 req/s per method, burst 100"]
        subgraph Funcs["Lambda functions, one IAM role each"]
            LH["health"]
            LE["events"]
            LB["booking"]
            LT["tickets"]
            LC["checkin"]
            LA["analytics"]
        end
    end

    subgraph Data
        DDB[("DynamoDB single table<br/>on-demand, TTL, Streams<br/>GSI1 user items, GSI2 public list")]
        SSM["SSM Parameter Store<br/>QR signing secret, SecureString"]
    end

    subgraph Pipeline["Analytics pipeline"]
        LS["Lambda: stream-processor<br/>idempotent counters"]
        DLQ[("SQS dead-letter queue")]
    end

    subgraph Monitoring
        CW["CloudWatch<br/>logs, EMF metrics, dashboard"]
        AL["4 alarms"]
        SNS["SNS topic<br/>e-mail subscription"]
    end

    U -->|"page and config.json"| CFW --> S3W
    U -->|"images"| CFI --> S3I
    U -->|"SRP sign in"| COG
    COG --> AT
    U -->|"HTTPS + ID token"| APIGW
    APIGW -.->|"validates token"| COG
    APIGW --> Funcs
    Funcs --> DDB
    LE -.->|"pre-signed POST, 120 s"| U
    U -->|"upload, max 2 MB, JPEG PNG WebP"| S3I
    LT -->|"read key"| SSM
    LC -->|"read key"| SSM

    DDB -->|"Streams: BOOKED to CHECKED_IN"| LS
    LS -->|"marker + counter + minute bucket, one transaction"| DDB
    LS -.->|"failed batches after 5 retries"| DLQ

    Funcs --> CW
    LS --> CW
    APIGW --> CW
    DDB --> CW
    DLQ --> CW
    CW --> AL --> SNS
```

Notes
- The browser holds only a Cognito ID token (sessionStorage) and public ids from `config.json`. It never holds AWS credentials or the QR secret.
- Each Lambda has its own IAM role. The stream processor's role is written out explicitly and limited to this table's stream.
- Metrics are written as Embedded Metric Format log lines, so there is no `PutMetricData` call and no extra permission.

## 2. Data model (single table)

```mermaid
erDiagram
    EVENT_META ||--o{ TICKET : "same partition EVENT#id"
    EVENT_META ||--o{ CHECKIN_BUCKET : "same partition EVENT#id"
    EVENT_META ||--o{ APPLIED_MARKER : "same partition EVENT#id"

    EVENT_META {
        string partitionKey "EVENT#eventId"
        string sortKey "META"
        number capacity
        number sold "changed only by booking transaction"
        number checkedIn "changed only by stream processor"
        string organizerId
        string gsi1 "USER#organizerId / EVENT#startsAt#id"
        string gsi2 "EVENTS / startsAt#id"
    }
    TICKET {
        string partitionKey "EVENT#eventId"
        string sortKey "TICKET#ticketId"
        string status "BOOKED or CHECKED_IN"
        string ownerId
        string gsi1 "USER#ownerId / TICKET#createdAt#id"
    }
    CHECKIN_BUCKET {
        string partitionKey "EVENT#eventId"
        string sortKey "CHECKIN#yyyy-MM-ddTHH:mm"
        number count
    }
    APPLIED_MARKER {
        string partitionKey "EVENT#eventId"
        string sortKey "APPLIED#checkin#ticketId"
        number ttl "expires after 3 days"
    }
```

(`partitionKey` and `sortKey` are the table's `PK` and `SK`; the ER notation reserves those two words.)

## 3. Deployment and delivery

```mermaid
flowchart LR
    DEV["Developer laptop"] -->|"npm run build<br/>sam deploy<br/>npm run deploy:frontend"| CFN["CloudFormation stack<br/>ticketing-platform"]
    DEV -.->|"push or manual run on main<br/>run green twice"| GH["GitHub Actions<br/>verify: lint, typecheck, tests, sam validate"]
    GH -.-> DEVJOB["deploy-dev<br/>automatic<br/>OIDC role ticketing-ci-dev"]
    DEVJOB -.-> APPROVE{"Required reviewer<br/>environment prod"}
    APPROVE -.-> PRODJOB["deploy-prod<br/>OIDC role ticketing-ci-prod"]
    DEVJOB -.-> STDEV["Stack ticketing-dev"]
    PRODJOB -.-> CFN
```

The dashed pipeline path has run green twice: once started by hand, once by a push to `main`. The solid path (laptop to stack) is what every deploy in Stages 3 to 9 used. See [ci-cd-setup.md](ci-cd-setup.md).
