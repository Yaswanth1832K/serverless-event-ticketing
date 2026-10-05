import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError, plainMessage, scanOutcomeFor } from './errors';
import { centsToDollars, dollarsToCents, formatPrice, isoToLocalInput, localInputToIso, plural, ticketsLeftLabel } from './format';

describe('format', () => {
  it('shows free events as Free and other prices as money', () => {
    expect(formatPrice(0)).toBe('Free');
    expect(formatPrice(1250, 'USD')).toContain('12.50');
  });
  it('labels availability in words', () => {
    expect(ticketsLeftLabel(0)).toBe('Sold out');
    expect(ticketsLeftLabel(1)).toBe('1 ticket left');
    expect(ticketsLeftLabel(7)).toBe('7 tickets left');
    expect(plural(1, 'ticket')).toBe('1 ticket');
    expect(plural(2, 'person', 'people')).toBe('2 people');
  });
  it('turns typed prices into whole cents and rejects nonsense', () => {
    expect(dollarsToCents('12.5')).toBe(1250);
    expect(dollarsToCents('0')).toBe(0);
    expect(dollarsToCents(' 5 ')).toBe(500);
    for (const bad of ['', 'abc', '-1', '1.234', '1,5', '1e3', '999999']) expect(dollarsToCents(bad)).toBeNull();
    expect(centsToDollars(1250)).toBe('12.50');
  });
  it('round-trips the date-time input through ISO', () => {
    const iso = '2030-06-01T10:30:00.000Z';
    expect(localInputToIso(isoToLocalInput(iso))).toBe(iso);
    expect(localInputToIso('not a date')).toBeNull();
  });
});

describe('plain-words errors', () => {
  it('explains a network failure', () => {
    expect(plainMessage(new NetworkError())).toMatch(/can't reach the server/i);
  });
  it('explains sold out, with and without seats left', () => {
    expect(plainMessage(new ApiError(409, 'SOLD_OUT', 'x', { remaining: 0 }))).toMatch(/sold out/i);
    expect(plainMessage(new ApiError(409, 'SOLD_OUT', 'x', { remaining: 3 }))).toMatch(/only 3 tickets are left/i);
    expect(plainMessage(new ApiError(409, 'SOLD_OUT', 'x', { remaining: 1 }))).toMatch(/only 1 ticket is left/i);
  });
  it('never shows raw codes or stack traces for server problems', () => {
    const msg = plainMessage(new ApiError(500, 'INTERNAL', 'Internal server error'));
    expect(msg).toMatch(/something went wrong on our side/i);
    expect(plainMessage(new ApiError(503, 'BUSY', 'x'))).toMatch(/try again in a moment/i);
    expect(plainMessage(new ApiError(403, 'FORBIDDEN', 'Requires one of: Organizer'))).not.toMatch(/Requires one of/);
    expect(plainMessage(new Error('boom'))).toBe('Something went wrong. Please try again.');
  });
  it('explains sign-in and sign-up problems', () => {
    expect(plainMessage({ code: 'NotAuthorizedException' })).toMatch(/email and password don't match/i);
    expect(plainMessage({ code: 'UsernameExistsException' })).toMatch(/already exists/i);
    expect(plainMessage({ name: 'InvalidPasswordException' })).toMatch(/too weak/i);
    expect(plainMessage({ code: 'UserLambdaValidationException' })).toMatch(/isn't allowed/i);
  });
  it('gives the scanner a clear verdict for every outcome', () => {
    const fmt = () => '10:05 AM';
    const o = (code: string, extra = {}) => scanOutcomeFor(new ApiError(409, code, 'm', extra), fmt);
    expect(o('ALREADY_USED', { checkedInAt: '2030-01-01T10:05:00Z' })).toMatchObject({ kind: 'bad', title: 'Already used' });
    expect(o('ALREADY_USED', { checkedInAt: '2030-01-01T10:05:00Z' }).detail).toContain('10:05 AM');
    expect(o('INVALID_TOKEN').title).toBe('Not a valid ticket');
    expect(o('TOKEN_EXPIRED').title).toBe('Ticket expired');
    expect(o('WRONG_EVENT').title).toBe('Wrong event');
    expect(o('TICKET_NOT_FOUND').title).toBe('Ticket not found');
    expect(scanOutcomeFor(new NetworkError(), fmt).kind).toBe('bad');
  });
});
