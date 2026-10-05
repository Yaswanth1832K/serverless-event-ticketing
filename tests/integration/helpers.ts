import { execFileSync } from 'node:child_process';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  AdminDeleteUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { LambdaClient, InvokeCommand, ListEventSourceMappingsCommand } from '@aws-sdk/client-lambda';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const STACK = process.env.STACK_NAME ?? 'ticketing-platform';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

export interface Outputs {
  apiUrl: string;
  userPoolId: string;
  clientId: string;
  imagesBaseUrl: string;
  imagesBucket: string;
  tableName: string;
  streamFunction: string;
  dlqUrl: string;
}

// Reads the deployed stack outputs with the AWS CLI so no ids are hardcoded in the repo.
export function loadOutputs(): Outputs {
  const raw = execFileSync(
    'aws',
    ['cloudformation', 'describe-stacks', '--stack-name', STACK, '--region', REGION,
      '--query', 'Stacks[0].Outputs', '--output', 'json'],
    { encoding: 'utf8' },
  );
  const map = Object.fromEntries(
    (JSON.parse(raw) as { OutputKey: string; OutputValue: string }[]).map((o) => [o.OutputKey, o.OutputValue]),
  );
  return {
    apiUrl: map.ApiUrl!,
    userPoolId: map.UserPoolId!,
    clientId: map.UserPoolClientId!,
    imagesBaseUrl: map.ImagesBaseUrl!,
    imagesBucket: map.ImagesBucketName!,
    tableName: map.TableName!,
    streamFunction: map.StreamProcessorFunctionName!,
    dlqUrl: map.StreamDlqUrl!,
  };
}

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

export interface TestUser {
  email: string;
  token: string;
}

export const PASSWORD = 'TestPass123';

export async function signUp(outputs: Outputs, role: string | undefined, label: string) {
  const email = `it-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await cognito.send(
    new SignUpCommand({
      ClientId: outputs.clientId,
      Username: email,
      Password: PASSWORD,
      UserAttributes: role === undefined ? [] : [{ Name: 'custom:role', Value: role }],
    }),
  );
  return email;
}

export async function login(outputs: Outputs, email: string): Promise<string> {
  const res = await cognito.send(
    new InitiateAuthCommand({
      ClientId: outputs.clientId,
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: email, PASSWORD },
    }),
  );
  return res.AuthenticationResult!.IdToken!;
}

export async function createUser(outputs: Outputs, role: string | undefined, label: string): Promise<TestUser> {
  const email = await signUp(outputs, role, label);
  // The group is added by the PostConfirmation trigger, so the first token already carries it.
  return { email, token: await login(outputs, email) };
}

// Staff cannot self-register (by design), so tests promote a throw-away user with the admin API
// using the developer's own AWS credentials, then log in again so the token carries the new group.
export async function createStaffUser(outputs: Outputs, label: string): Promise<TestUser> {
  const email = await signUp(outputs, 'Attendee', label);
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: outputs.userPoolId, Username: email, GroupName: 'Staff' }));
  await cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: outputs.userPoolId, Username: email, GroupName: 'Attendee' }));
  return { email, token: await login(outputs, email) };
}

// Reads the QR signing secret into memory so tests can mint an EXPIRED token (the API never issues
// one). The value is never logged or written anywhere. Needs ssm:GetParameter and decrypt rights.
export async function readQrSecret(): Promise<string> {
  const ssm = new SSMClient({ region: REGION });
  const res = await ssm.send(
    new GetParameterCommand({ Name: '/ticketing-platform/qr-signing-secret', WithDecryption: true }),
  );
  return res.Parameter!.Value!;
}

export async function deleteUser(outputs: Outputs, email: string): Promise<void> {
  try {
    await cognito.send(new AdminDeleteUserCommand({ UserPoolId: outputs.userPoolId, Username: email }));
  } catch {
    // Cleanup is best effort (needs cognito-idp:AdminDeleteUser).
  }
}

export async function api(
  outputs: Outputs,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(`${outputs.apiUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: token } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // non-JSON body
  }
  return { status: res.status, body: parsed, raw };
}

// Readiness gate. A freshly deployed API can briefly answer with API Gateway's own 403/404
// ("Missing Authentication Token") for routes that are not live yet. Our Lambdas answer with a
// JSON body containing an `error` code, so we wait until that appears. Then a small parallel
// burst warms several Lambda containers so the real test measures steady-state behaviour.
const NIL_ID = '00000000-0000-4000-8000-000000000000';

// One entry per API route. A route counts as live once OUR Lambda answers it (a JSON body with an
// `error` code). A route that has not propagated yet is answered by API Gateway itself with a bare
// 403 `{"message": ...}` that has no `error` field. Seen after stack updates in Stage 4 and Stage 6.
const lambdaAnswered = (r: { status: number; body: any }, status: number, error: string) =>
  r.status === status && r.body?.error === error;

export async function waitForRoutes(outputs: Outputs, attendeeToken: string, timeoutMs = 120_000): Promise<void> {
  const checks: [string, string, unknown, (r: { status: number; body: any }) => boolean][] = [
    ['GET', '/events', undefined, (r) => r.status === 200],
    ['GET', '/my/events', undefined, (r) => lambdaAnswered(r, 403, 'FORBIDDEN')],
    ['GET', '/my/tickets', undefined, (r) => r.status === 200],
    ['POST', `/events/${NIL_ID}/book`, { quantity: 1 }, (r) => lambdaAnswered(r, 404, 'NOT_FOUND')],
    ['GET', `/events/${NIL_ID}/tickets/${NIL_ID}/qr`, undefined, (r) => lambdaAnswered(r, 404, 'TICKET_NOT_FOUND')],
    ['POST', '/checkin', { token: 'x', eventId: NIL_ID }, (r) => lambdaAnswered(r, 403, 'FORBIDDEN')],
    ['GET', '/dashboard', undefined, (r) => lambdaAnswered(r, 403, 'FORBIDDEN')],
    ['GET', `/events/${NIL_ID}/analytics`, undefined, (r) => lambdaAnswered(r, 403, 'FORBIDDEN')],
  ];
  const deadline = Date.now() + timeoutMs;
  for (const [method, path, body, ok] of checks) {
    for (;;) {
      const r = await api(outputs, method, path, attendeeToken, body);
      if (ok(r)) break;
      if (Date.now() > deadline) throw new Error(`Route not live after ${timeoutMs}ms: ${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
  await Promise.all(
    Array.from({ length: 10 }, () => api(outputs, 'POST', `/events/${NIL_ID}/book`, attendeeToken, { quantity: 1 })),
  );
}

// Test-data cleanup straight from DynamoDB (events with sold tickets cannot be deleted via the API).
// Uses the developer's own AWS credentials. Best effort.
export async function purgeEvent(outputs: Outputs, eventId: string): Promise<void> {
  try {
    const keys: { PK: string; SK: string }[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(
        new QueryCommand({
          TableName: outputs.tableName,
          KeyConditionExpression: 'PK = :p',
          ExpressionAttributeValues: { ':p': `EVENT#${eventId}` },
          ProjectionExpression: 'PK, SK',
          ExclusiveStartKey: start,
        }),
      );
      keys.push(...(res.Items as { PK: string; SK: string }[]));
      start = res.LastEvaluatedKey;
    } while (start);
    for (let i = 0; i < keys.length; i += 25) {
      await ddb.send(
        new BatchWriteCommand({
          RequestItems: { [outputs.tableName]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) },
        }),
      );
    }
  } catch (err) {
    console.warn(`purgeEvent(${eventId}) skipped: ${String(err)}`);
  }
}

// ---- Stage 7 helpers -------------------------------------------------------------------------

const lambda = new LambdaClient({ region: REGION });
const sqs = new SQSClient({ region: REGION });

// The stream trigger is created with StartingPosition LATEST, so a record written before the
// mapping is Enabled would never be delivered. Wait for it before generating any check-ins.
export async function waitForStreamMapping(outputs: Outputs, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: outputs.streamFunction }));
    const m = res.EventSourceMappings?.[0];
    if (m?.State === 'Enabled') return;
    if (Date.now() > deadline) throw new Error(`Stream mapping not Enabled after ${timeoutMs}ms (state: ${m?.State})`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// Calls the deployed stream-processor directly with a hand-built stream event. This is how a
// replayed or redelivered batch is simulated. Needs lambda:InvokeFunction.
export async function invokeStreamProcessor(outputs: Outputs, payload: unknown): Promise<{ functionError?: string; result: any }> {
  const res = await lambda.send(
    new InvokeCommand({ FunctionName: outputs.streamFunction, Payload: Buffer.from(JSON.stringify(payload)) }),
  );
  return { functionError: res.FunctionError, result: JSON.parse(Buffer.from(res.Payload ?? []).toString() || 'null') };
}

export async function dlqDepth(outputs: Outputs): Promise<number> {
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: outputs.dlqUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(res.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

// Ground truth, read straight from DynamoDB (not through the API): the real ticket items of an event.
export async function ticketsInDb(outputs: Outputs, eventId: string): Promise<{ total: number; checkedIn: number; booked: number }> {
  let total = 0, checkedIn = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: outputs.tableName,
        KeyConditionExpression: 'PK = :p AND begins_with(SK, :t)',
        ExpressionAttributeValues: { ':p': `EVENT#${eventId}`, ':t': 'TICKET#' },
        ExpressionAttributeNames: { '#s': 'status' },
        ProjectionExpression: '#s',
        ConsistentRead: true,
        ExclusiveStartKey: start,
      }),
    );
    for (const it of res.Items ?? []) {
      total++;
      if (it.status === 'CHECKED_IN') checkedIn++;
    }
    start = res.LastEvaluatedKey;
  } while (start);
  return { total, checkedIn, booked: total - checkedIn };
}

// Has the stream processor applied this ticket's check-in? (The idempotency marker is written in the
// same transaction as the counters, so its presence means "counted".)
export async function isCounted(outputs: Outputs, eventId: string, ticketId: string): Promise<boolean> {
  const res = await ddb.send(
    new GetCommand({
      TableName: outputs.tableName,
      Key: { PK: `EVENT#${eventId}`, SK: `APPLIED#checkin#${ticketId}` },
      ConsistentRead: true,
    }),
  );
  return Boolean(res.Item);
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const s = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - s };
}

export function stats(values: number[]): string {
  const v = [...values].sort((a, b) => a - b);
  const at = (p: number) => v[Math.min(v.length - 1, Math.floor(v.length * p))]!;
  const avg = Math.round(v.reduce((a, b) => a + b, 0) / v.length);
  return `n=${v.length} min=${v[0]}ms p50=${at(0.5)}ms p95=${at(0.95)}ms max=${v[v.length - 1]}ms avg=${avg}ms`;
}

export const futureDate =(days = 7) => new Date(Date.now() + days * 86_400_000).toISOString();

export async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, tries = 10, ms = 1500): Promise<T> {
  let last!: T;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, ms));
  }
  return last;
}
