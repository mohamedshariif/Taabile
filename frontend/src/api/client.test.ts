import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, getAccessToken, setAccessToken } from './client';

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe('api client', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    setAccessToken('old');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the access token and parses the answer', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    expect(await api('/ping')).toEqual({ ok: true });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer old');
    expect(init.credentials).toBe('include');
  });

  it('turns the uniform error shape into an ApiError', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { error: { code: 'CONFLICT', message: 'Taken' } }));
    await expect(api('/x', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 409, code: 'CONFLICT', message: 'Taken' });
    expect(ApiError).toBeDefined();
  });

  it('on 401 refreshes once and retries with the new token', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } })) // first try
      .mockResolvedValueOnce(json(200, { accessToken: 'new' })) // refresh
      .mockResolvedValueOnce(json(200, { done: 1 })); // retry
    expect(await api('/secret')).toEqual({ done: 1 });
    expect(getAccessToken()).toBe('new');
    expect((fetchMock.mock.calls[2]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer new' });
  });

  it('many parallel 401s cause ONE refresh (a refresh token works only once)', async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === '/api/auth/refresh') return json(200, { accessToken: 'fresh' });
      const bearer = (init.headers as Record<string, string>).Authorization;
      return bearer === 'Bearer fresh' ? json(200, { ok: 1 }) : json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } });
    });
    await Promise.all([api('/a'), api('/b'), api('/c')]);
    const refreshCalls = fetchMock.mock.calls.filter((c) => c[0] === '/api/auth/refresh');
    expect(refreshCalls).toHaveLength(1);
  });

  it('does not refresh when noRefresh is set (wrong password on login is a plain 401)', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHORIZED', message: 'Wrong email or password' } }));
    await expect(api('/auth/login', { method: 'POST', body: {}, noRefresh: true })).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the Idempotency-Key header when given', async () => {
    fetchMock.mockResolvedValueOnce(json(201, {}));
    await api('/things', { method: 'POST', body: {}, idempotencyKey: 'abc12345' });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'Idempotency-Key': 'abc12345' });
  });
});