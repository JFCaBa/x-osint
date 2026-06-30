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

describe('reports api', () => {
  beforeEach(() => { api.setToken('tok'); });

  it('reportsSummary builds the query string', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ count: 3, lastExportAt: null, aiAvailable: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await api.reportsSummary({ mode: 'range', from: '2026-06-01', to: '2026-06-30' });
    expect(r.count).toBe(3);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/reports/summary?');
    expect(url).toContain('mode=range');
    expect(url).toContain('from=2026-06-01');
    expect(url).toContain('to=2026-06-30');
  });

  it('listPosts passes angleOnly', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.listPosts({ angleOnly: true });
    expect(fetchMock.mock.calls[0][0]).toContain('angleOnly=true');
  });
});

describe('settings api', () => {
  beforeEach(() => { api.setToken('tok'); });

  it('getSettings GETs /settings', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ filters: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.getSettings();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/settings');
    expect((opts as RequestInit).method).toBe('GET');
  });

  it('saveSettings PUTs the filters', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ filters: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.saveSettings([{ label: 'tech', color: '#112233', emoji: '🤖' }]);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/settings');
    expect((opts as RequestInit).method).toBe('PUT');
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ filters: [{ label: 'tech', color: '#112233', emoji: '🤖' }] });
  });

  it('reclassifyAll POSTs /settings/reclassify', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ queued: 3 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await api.reclassifyAll()).toEqual({ queued: 3 });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/settings/reclassify');
    expect((opts as RequestInit).method).toBe('POST');
  });
});
