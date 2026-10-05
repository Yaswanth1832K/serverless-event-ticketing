import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Role } from '../api/types';
import { setConfigForTests } from '../config';

export function useTestConfig() {
  setConfigForTests({ apiUrl: 'https://api.test/prod', region: 'us-east-1', userPoolId: 'pool', userPoolClientId: 'client', currency: 'USD' });
}

// A stand-in for the value useAuth() returns, so pages can be tested as any kind of user.
export function makeAuth(roles: Role[] | null, overrides: Record<string, unknown> = {}) {
  return {
    status: roles ? 'signedIn' : 'signedOut',
    user: roles ? { sub: 'u1', email: 'me@example.com', groups: roles } : null,
    notice: null,
    signIn: vi.fn(async () => {}),
    register: vi.fn(async () => {}),
    signOut: vi.fn(),
    clearNotice: vi.fn(),
    hasRole: (...wanted: Role[]) => Boolean(roles?.some((r) => wanted.includes(r))),
    ...overrides,
  };
}

// Renders a page at a URL, with the route pattern it normally lives under.
export function renderAt(ui: ReactElement, opts: { path?: string; route?: string } = {}) {
  const path = opts.path ?? '/';
  return render(
    <MemoryRouter initialEntries={[opts.route ?? path]}>
      <Routes>
        <Route path={path} element={ui} />
        <Route path="*" element={<p>other page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

export const future = (days = 3) => new Date(Date.now() + days * 86_400_000).toISOString();

export function makeEvent(over: Record<string, unknown> = {}) {
  return {
    eventId: '11111111-1111-4111-8111-111111111111',
    name: 'Tech Fest', description: 'A day of talks', venue: 'Main Hall', startsAt: future(),
    priceCents: 500, capacity: 10, sold: 2, remaining: 8, imageUrl: null, createdAt: new Date().toISOString(),
    ...over,
  };
}
