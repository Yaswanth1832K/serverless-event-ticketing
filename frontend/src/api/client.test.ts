import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, request, setAuthHooks } from './client';
import { ApiError, NetworkError } from '../lib/errors';
import { useTestConfig } from '../test/helpers';

const fetchMock = vi.fn();
const unauthorized = vi.fn();

function reply(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(body === undefined ? '' : JSON.stringify(body), { status }));
}

beforeEach(() => {
  useTestConfig();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  unauthorized.mockReset();
  setAuthHooks({ getToken: async () => 'TOKEN', onUnauthorized: unauthorized });
});
afterEach(() => vi.unstubAllGlobals());

describe('API client', () => {
  it('sends the sign-in token on protected calls and none on public ones', async () => {
    reply(200, { tickets: [] });
    await api.myTickets();
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('TOKEN');
    reply(200, { events: [] });
    await api.listEvents();
    expect(fetchMock.mock.calls[1]![1].headers.Authorization).toBeUndefined();
    expect(fetchMock.mock.calls[1]![0]).toBe('https://api.test/prod/events');
  });

  it('sends JSON bodies', async () => {
    reply(201, { eventId: 'e', quantity: 2, totalPriceCents: 0, tickets: [] });
    await api.book('e1', 2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/events/e1/book');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ quantity: 2 });
  });

  it('turns an error response into an ApiError carrying the code and extras', async () => {
    reply(409, { error: 'SOLD_OUT', message: 'Sold out', remaining: 0 });
    await expect(api.book('e1', 1)).rejects.toMatchObject({ status: 409, code: 'SOLD_OUT', extra: { remaining: 0 } });
  });

  it("treats API Gateway's own 401 (no error code) as a finished session", async () => {
    reply(401, { message: 'Unauthorized' });
    await expect(api.myTickets()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not call the server at all when there is no token', async () => {
    setAuthHooks({ getToken: async () => null, onUnauthorized: unauthorized });
    await expect(api.dashboard()).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unauthorized).toHaveBeenCalled();
  });

  it('reports a network failure as a NetworkError', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api.listEvents()).rejects.toBeInstanceOf(NetworkError);
  });

  it('survives an empty or non-JSON error body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(request('GET', '/events', { auth: 'none' })).rejects.toMatchObject({ status: 502, code: 'HTTP_502' });
  });
});
