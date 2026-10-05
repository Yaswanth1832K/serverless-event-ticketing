import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setAuthHooks } from '../api/client';
import type { Role } from '../api/types';
import { SESSION_ENDED } from '../lib/errors';
import * as cognito from './cognito';
import type { SessionUser } from './cognito';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthValue {
  status: Status;
  user: SessionUser | null;
  /** A one-off message to show on the login page, for example "Your session has ended". */
  notice: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, role: 'Attendee' | 'Organizer') => Promise<void>;
  signOut: () => void;
  clearNotice: () => void;
  hasRole: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthValue | null>(null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const endSession = useCallback((message: string | null) => {
    cognito.signOut();
    setUser(null);
    setStatus('signedOut');
    setNotice(message);
  }, []);

  useEffect(() => {
    // The API client asks us for the token on every call, and tells us when the server says 401.
    setAuthHooks({ getToken: cognito.idToken, onUnauthorized: () => endSession(SESSION_ENDED) });
    let alive = true;
    cognito.currentUser().then((u) => {
      if (!alive) return;
      setUser(u);
      setStatus(u ? 'signedIn' : 'signedOut');
    });
    return () => {
      alive = false;
    };
  }, [endSession]);

  const signIn = useCallback(async (email: string, password: string) => {
    const u = await cognito.signIn(email.trim().toLowerCase(), password);
    setUser(u);
    setStatus('signedIn');
    setNotice(null);
  }, []);

  const register = useCallback(
    async (email: string, password: string, role: 'Attendee' | 'Organizer') => {
      const clean = email.trim().toLowerCase();
      await cognito.signUp(clean, password, role);
      // The server adds the new account to its group a moment after sign-up. If the first sign-in
      // does not carry the group yet, try again briefly so the right menu shows straight away.
      let u = await cognito.signIn(clean, password);
      for (let i = 0; i < 3 && u.groups.length === 0; i++) {
        await sleep(1200);
        u = await cognito.signIn(clean, password);
      }
      setUser(u);
      setStatus('signedIn');
      setNotice(null);
    },
    [],
  );

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      notice,
      signIn,
      register,
      signOut: () => endSession(null),
      clearNotice: () => setNotice(null),
      hasRole: (...roles) => Boolean(user?.groups.some((g) => roles.includes(g))),
    }),
    [status, user, notice, signIn, register, endSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
