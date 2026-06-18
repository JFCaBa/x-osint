import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api, ApiError } from '../src/services/api';

describe('api client', () => {
  beforeEach(() => { api.setToken(null); vi.restoreAllMocks(); });

  it('login posts password and returns token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: 'abc' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const token = await api.login('pw');
    expect(token).toBe('abc');
    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ password: 'pw' });
  });

  it('attaches bearer token after setToken', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    api.setToken('tok');
    await api.listAccounts();
    const [, opts] = fetchMock.mock.calls[0];
    expect((opts as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('throws ApiError with status on non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401 })));
    await expect(api.listAccounts()).rejects.toMatchObject({ status: 401 });
    await expect(api.listAccounts()).rejects.toBeInstanceOf(ApiError);
  });
});
