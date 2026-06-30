export interface Account {
  handle: string;
  display_name: string | null;
  enabled: boolean;
  added_at: string;
  last_fetched_at: string | null;
  last_status: 'ok' | 'error' | null;
}
export interface Post {
  id: string;
  handle: string;
  text: string;
  url: string | null;
  media_url: string | null;
  posted_at: string;
  fetched_at: string;
  angle_match?: number | null;
  angles?: string | null;
  text_pt?: string | null;
}

export interface ReportSummary {
  count: number;
  lastExportAt: string | null;
  aiAvailable: boolean;
}
export interface ReportParams {
  mode: 'since-last' | 'range';
  from?: string;
  to?: string;
}

export interface Filter {
  label: string;
  color: string;
  emoji: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let token: string | null = null;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    if (res.status === 401) {
      token = null;
      if (typeof localStorage !== 'undefined') localStorage.removeItem('x-osint-token');
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.assign('/login');
      }
    }
    const msg = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, (msg as { error?: string }).error ?? 'request failed');
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  setToken(t: string | null): void { token = t; },
  async login(password: string): Promise<string> {
    const r = await call<{ token: string }>('POST', '/login', { password });
    return r.token;
  },
  listAccounts(): Promise<Account[]> { return call<Account[]>('GET', '/accounts'); },
  addAccount(handle: string): Promise<Account> { return call<Account>('POST', '/accounts', { handle }); },
  setEnabled(handle: string, enabled: boolean): Promise<Account> {
    return call<Account>('PATCH', `/accounts/${encodeURIComponent(handle)}`, { enabled });
  },
  removeAccount(handle: string): Promise<void> {
    return call<void>('DELETE', `/accounts/${encodeURIComponent(handle)}`);
  },
  listPosts(params: { handle?: string; q?: string; limit?: number; angleOnly?: boolean; angle?: string }): Promise<Post[]> {
    const qs = new URLSearchParams();
    if (params.handle) qs.set('handle', params.handle);
    if (params.q) qs.set('q', params.q);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.angleOnly) qs.set('angleOnly', 'true');
    if (params.angle) qs.set('angle', params.angle);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return call<Post[]>('GET', `/posts${suffix}`);
  },
  triggerFetch(): Promise<void> { return call<void>('POST', '/fetch'); },
  reportsSummary(params: ReportParams): Promise<ReportSummary> {
    const qs = new URLSearchParams();
    qs.set('mode', params.mode);
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    return call<ReportSummary>('GET', `/reports/summary?${qs.toString()}`);
  },
  async exportReport(params: ReportParams): Promise<void> {
    const res = await fetch('/api/reports/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new ApiError(res.status, 'export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'x-osint-report.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  },
  getSettings(): Promise<{ filters: Filter[] }> { return call<{ filters: Filter[] }>('GET', '/settings'); },
  saveSettings(filters: Filter[]): Promise<{ filters: Filter[] }> { return call<{ filters: Filter[] }>('PUT', '/settings', { filters }); },
  reclassifyAll(): Promise<{ queued: number }> { return call<{ queued: number }>('POST', '/settings/reclassify'); },
};
