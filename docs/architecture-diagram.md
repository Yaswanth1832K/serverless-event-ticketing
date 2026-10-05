# Architecture diagrams (final)

These show the system **as deployed** in stack `ticketing-platform`, us-east-1. The sequence diagrams for booking and check-in are in [02-architecture.md](02-architecture.md). Mermaid renders on GitHub and in VS Code with a Mermaid extension. PNG renders of every diagram are in [diagrams/](diagrams/) (made with mermaid-cli; see the README there).

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
    DEV -.->|"git push main<br/>NOT YET RUN"| GH["GitHub Actions<br/>verify: lint, typecheck, tests, sam validate"]
    GH -.-> DEVJOB["deploy-dev<br/>automatic<br/>OIDC role ticketing-ci-dev"]
    DEVJOB -.-> APPROVE{"Required reviewer<br/>environment prod"}
    APPROVE -.-> PRODJOB["deploy-prod<br/>OIDC role ticketing-ci-prod"]
    DEVJOB -.-> STDEV["Stack ticketing-dev"]
    PRODJOB -.-> CFN
```

Dashed lines are **written but never run**. The solid path (laptop to stack) is what every deploy in Stages 3 to 9 used. See [ci-cd-setup.md](ci-cd-setup.md).
