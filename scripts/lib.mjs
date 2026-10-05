// Shared helpers for the project scripts (plain Node, no build step).
import { execFileSync } from 'node:child_process';
import {
  CognitoIdentityProviderClient, SignUpCommand, InitiateAuthCommand, AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand, AdminDeleteUserCommand, ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

export const STACK = process.env.STACK_NAME ?? 'ticketing-platform';
export const REGION = process.env.AWS_REGION ?? 'us-east-1';

export function aws(args, opts = {}) {
  return execFileSync('aws', [...args, '--region', REGION], { encoding: 'utf8', ...opts });
}

// CloudFormation outputs as { ApiUrl, UserPoolId, ... }. Nothing is hardcoded in the repo.
export function stackOutputs() {
  let raw;
  try {
    raw = aws(['cloudformation', 'describe-stacks', '--stack-name', STACK, '--query', 'Stacks[0].Outputs', '--output', 'json']);
  } catch {
    throw new Error(`Could not read the "${STACK}" stack in ${REGION}. Is it deployed, and are your AWS credentials set?`);
  }
  return Object.fromEntries(JSON.parse(raw).map((o) => [o.OutputKey, o.OutputValue]));
}

const cognito = new CognitoIdentityProviderClient({ region: REGION });
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

export async function signUpIfNeeded(out, email, password, role) {
  try {
    await cognito.send(new SignUpCommand({
      ClientId: out.UserPoolClientId, Username: email, Password: password,
      UserAttributes: role ? [{ Name: 'custom:role', Value: role }] : [],
    }));
    return true;
  } catch (e) {
    if (e.name === 'UsernameExistsException') return false;
    throw e;
  }
}

export async function login(out, email, password) {
  const res = await cognito.send(new InitiateAuthCommand({
    ClientId: out.UserPoolClientId, AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  return res.AuthenticationResult.IdToken;
}

// Door staff cannot sign themselves up. An administrator (you, with your AWS credentials) adds them.
export async function makeStaff(out, email) {
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: out.UserPoolId, Username: email, GroupName: 'Staff' }));
  await cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: out.UserPoolId, Username: email, GroupName: 'Attendee' })).catch(() => {});
}

export async function deleteUser(out, email) {
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: out.UserPoolId, Username: email })).catch(() => {});
}

export async function listUsersWithPrefix(out, prefix) {
  const emails = [];
  let token;
  do {
    const res = await cognito.send(new ListUsersCommand({ UserPoolId: out.UserPoolId, PaginationToken: token, Limit: 60 }));
    for (const u of res.Users ?? []) {
      const email = u.Attributes?.find((a) => a.Name === 'email')?.Value ?? '';
      if (email.startsWith(prefix)) emails.push(email);
    }
    token = res.PaginationToken;
  } while (token);
  return emails;
}

export function apiClient(out) {
  return async function call(method, path, token, body) {
    const res = await fetch(`${out.ApiUrl}${path}`, {
      method,
      headers: { ...(token ? { Authorization: token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, text };
  };
}

// Admin cleanup: removes an event and everything stored under it (tickets, counters, markers).
// This writes to DynamoDB directly with YOUR AWS credentials, so it is only used by the explicit
// clean-up scripts, never by the seeding itself.
export async function purgeEvent(out, eventId) {
  const keys = [];
  let start;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: out.TableName, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': `EVENT#${eventId}` },
      ProjectionExpression: 'PK, SK', ExclusiveStartKey: start,
    }));
    keys.push(...res.Items);
    start = res.LastEvaluatedKey;
  } while (start);
  for (let i = 0; i < keys.length; i += 25) {
    await ddb.send(new BatchWriteCommand({
      RequestItems: { [out.TableName]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) },
    }));
  }
  return keys.length;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
