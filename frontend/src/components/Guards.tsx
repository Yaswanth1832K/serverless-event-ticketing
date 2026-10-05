import type { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import type { Role } from '../api/types';
import { Loading, EmptyState } from './States';

// These guards only decide what the menu and pages SHOW. The real permission checks are on the
// server: even if someone opens a page they should not see, every API call is refused with 403.
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Loading label="Checking your sign-in…" />;
  if (status === 'signedOut') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

const ROLE_WORDS: Record<Role, string> = {
  Organizer: 'event organizers',
  Attendee: 'attendees',
  Staff: 'door staff',
};

export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { hasRole } = useAuth();
  return (
    <RequireAuth>
      {hasRole(...roles) ? (
        children
      ) : (
        <EmptyState
          title="This page isn't for your account"
          action={
            <Link className="btn" to="/">
              Back to events
            </Link>
          }
        >
          This page is only for {roles.map((r) => ROLE_WORDS[r]).join(' and ')}. You are signed in with a different kind of account.
        </EmptyState>
      )}
    </RequireAuth>
  );
}
