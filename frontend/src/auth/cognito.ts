import {
  AuthenticationDetails, CognitoUser, CognitoUserAttribute, CognitoUserPool,
  type CognitoUserSession, type ICognitoStorage,
} from 'amazon-cognito-identity-js';
import { config } from '../config';
import type { Role } from '../api/types';

// Thin promise wrapper around amazon-cognito-identity-js. The password is never sent to our own
// API: the library proves it knows the password with SRP and Cognito hands back signed tokens.

export interface SessionUser {
  sub: string;
  email: string;
  groups: Role[];
}

// Tokens live in sessionStorage: gone when the tab closes, and not shared between tabs. This is
// safer than localStorage but not immune to XSS (see docs/security.md). If the browser blocks
// storage entirely, fall back to memory so sign-in still works for the current page.
class MemoryStorage implements ICognitoStorage {
  private data = new Map<string, string>();
  setItem(key: string, value: string) { this.data.set(key, value); return value; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  removeItem(key: string) { this.data.delete(key); return true; }
  clear() { this.data.clear(); return {}; }
}

function pickStorage(): ICognitoStorage {
  try {
    sessionStorage.setItem('__probe', '1');
    sessionStorage.removeItem('__probe');
    return sessionStorage;
  } catch {
    return new MemoryStorage();
  }
}

let pool: CognitoUserPool | undefined;
let storage: ICognitoStorage | undefined;

function userPool(): CognitoUserPool {
  if (!pool) {
    storage = pickStorage();
    pool = new CognitoUserPool({
      UserPoolId: config().userPoolId,
      ClientId: config().userPoolClientId,
      Storage: storage,
    });
  }
  return pool;
}

const KNOWN_ROLES: Role[] = ['Organizer', 'Attendee', 'Staff'];

export function userFromSession(session: CognitoUserSession): SessionUser {
  const p = session.getIdToken().payload as Record<string, unknown>;
  const raw = p['cognito:groups'];
  const groups = (Array.isArray(raw) ? raw : []).filter((g): g is Role => KNOWN_ROLES.includes(g as Role));
  return { sub: String(p.sub ?? ''), email: String(p.email ?? ''), groups };
}

export function signUp(email: string, password: string, role: 'Attendee' | 'Organizer'): Promise<void> {
  const attributes = [
    new CognitoUserAttribute({ Name: 'email', Value: email }),
    new CognitoUserAttribute({ Name: 'custom:role', Value: role }),
  ];
  return new Promise((resolve, reject) => {
    userPool().signUp(email, password, attributes, [], (err) => (err ? reject(err) : resolve()));
  });
}

export function signIn(email: string, password: string): Promise<SessionUser> {
  const user = new CognitoUser({ Username: email, Pool: userPool(), Storage: storage });
  const details = new AuthenticationDetails({ Username: email, Password: password });
  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: (session) => resolve(userFromSession(session)),
      onFailure: reject,
      newPasswordRequired: () => reject(Object.assign(new Error('new password required'), { code: 'NotAuthorizedException' })),
    });
  });
}

// Returns the current session, refreshing the tokens first if they have expired.
function getSession(): Promise<CognitoUserSession | null> {
  const user = userPool().getCurrentUser();
  if (!user) return Promise.resolve(null);
  return new Promise((resolve) => {
    user.getSession((err: Error | null, session: CognitoUserSession | null) => resolve(err || !session?.isValid() ? null : session));
  });
}

export async function currentUser(): Promise<SessionUser | null> {
  const session = await getSession();
  return session ? userFromSession(session) : null;
}

export async function idToken(): Promise<string | null> {
  const session = await getSession();
  return session ? session.getIdToken().getJwtToken() : null;
}

export function signOut(): void {
  userPool().getCurrentUser()?.signOut();
}
