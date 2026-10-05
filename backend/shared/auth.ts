import type { APIGatewayProxyEvent } from 'aws-lambda';
import { HttpError } from './http';

export type Role = 'Organizer' | 'Attendee' | 'Staff';

export interface AuthUser {
  sub: string;
  email: string;
  groups: Role[];
}

const VALID_ROLES: Role[] = ['Organizer', 'Attendee', 'Staff'];

// API Gateway passes cognito:groups as a string such as "Organizer" or "[Organizer Staff]".
export function parseGroups(raw: unknown): Role[] {
  if (Array.isArray(raw)) raw = raw.join(',');
  if (typeof raw !== 'string') return [];
  return raw
    .replace(/[[\]]/g, '')
    .split(/[\s,]+/)
    .filter((g): g is Role => (VALID_ROLES as string[]).includes(g));
}

// Reads the identity from claims that API Gateway has already verified.
// Never trusts anything from the request body or headers.
export function getUser(event: Pick<APIGatewayProxyEvent, 'requestContext'>): AuthUser {
  const claims = event.requestContext?.authorizer?.claims as Record<string, unknown> | undefined;
  if (!claims || typeof claims.sub !== 'string') {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Missing or invalid identity');
  }
  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : '',
    groups: parseGroups(claims['cognito:groups']),
  };
}

export function requireRole(user: AuthUser, ...allowed: Role[]): void {
  if (!user.groups.some((g) => allowed.includes(g))) {
    throw new HttpError(403, 'FORBIDDEN', `Requires one of: ${allowed.join(', ')}`);
  }
}
