import { describe, it, expect } from 'vitest';
import { parseGroups, getUser, requireRole } from '../../backend/shared/auth';
import { corsHeaders } from '../../backend/shared/http';
import { groupForRole, handler as authHandler } from '../../backend/functions/auth-triggers/index';

describe('parseGroups', () => {
  it('parses a single group', () => expect(parseGroups('Organizer')).toEqual(['Organizer']));
  it('parses bracketed lists', () =>
    expect(parseGroups('[Organizer Staff]')).toEqual(['Organizer', 'Staff']));
  it('parses comma lists', () =>
    expect(parseGroups('Organizer, Staff')).toEqual(['Organizer', 'Staff']));
  it('ignores unknown groups and bad input', () => {
    expect(parseGroups('Admin')).toEqual([]);
    expect(parseGroups(undefined)).toEqual([]);
  });
});

describe('getUser / requireRole', () => {
  const ev = (claims: unknown) => ({ requestContext: { authorizer: { claims } } }) as never;

  it('reads identity from verified claims', () => {
    const u = getUser(ev({ sub: 'abc', email: 'a@b.c', 'cognito:groups': 'Attendee' }));
    expect(u).toEqual({ sub: 'abc', email: 'a@b.c', groups: ['Attendee'] });
  });
  it('rejects missing claims with 401', () => {
    expect(() => getUser(ev(undefined))).toThrow(/identity/);
  });
  it('requireRole throws 403 for the wrong role', () => {
    const u = { sub: 'x', email: '', groups: ['Attendee' as const] };
    expect(() => requireRole(u, 'Organizer')).toThrow(/Requires/);
    expect(() => requireRole(u, 'Attendee')).not.toThrow();
  });
});

describe('CORS allowlist', () => {
  it('echoes only allowlisted origins', () => {
    process.env.ALLOWED_ORIGINS = 'https://good.example';
    expect(corsHeaders('https://good.example')['Access-Control-Allow-Origin']).toBe(
      'https://good.example',
    );
    expect(corsHeaders('https://evil.example')['Access-Control-Allow-Origin']).toBeUndefined();
    expect(corsHeaders(undefined)['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('PreSignUp trigger rejects unauthorized roles', () => {
  const pre = (role?: string) =>
    ({
      triggerSource: 'PreSignUp_SignUp',
      request: { userAttributes: role === undefined ? {} : { 'custom:role': role } },
      response: {},
    }) as never;

  it('rejects Staff, Admin and junk at signup', async () => {
    for (const bad of ['Staff', 'Admin', 'organizer', 'Organizer,Staff', ' Organizer']) {
      await expect(authHandler(pre(bad))).rejects.toThrow(/Invalid role/);
    }
  });
  it('auto-confirms Attendee, Organizer and missing role', async () => {
    for (const ok of ['Attendee', 'Organizer', undefined]) {
      const res = (await authHandler(pre(ok))) as { response: { autoConfirmUser?: boolean } };
      expect(res.response.autoConfirmUser).toBe(true);
    }
  });
});

describe('signup role mapping', () => {
  it('lets users pick Organizer or Attendee only', () => {
    expect(groupForRole('Organizer')).toBe('Organizer');
    expect(groupForRole('Staff')).toBe('Attendee');
    expect(groupForRole('Admin')).toBe('Attendee');
    expect(groupForRole(undefined)).toBe('Attendee');
  });
});
