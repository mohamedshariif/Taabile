export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
export const getAccessToken = () => accessToken;

// Called when the session is really over (refresh failed), so the app can show the login page.
let onSessionLost: () => void = () => {};
export const setSessionLostHandler = (fn: () => void) => {
  onSessionLost = fn;
};

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toError(res: Response, body: unknown): ApiError {
  const e = (body as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
  return new ApiError(res.status, e?.code ?? 'UNKNOWN', e?.message ?? `Request failed (${res.status})`, e?.details);
}

// If five requests fail with 401 at the same moment, we must refresh ONCE, not five times:
// a refresh token works only once. All callers share this single in-flight promise.
let refreshing: Promise<string | null> | null = null;

export function refreshAccessToken(): Promise<string | null> {
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) return null;
        const body = (await parse(res)) as { accessToken?: string } | undefined;
        return body?.accessToken ?? null;
      })
      .catch(() => null)
      .then((token) => {
        accessToken = token;
        return token;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Send an Idempotency-Key header (use for every create request that needs it). */
  idempotencyKey?: string;
  /** Do not try to refresh on 401 (used by login itself, where 401 means "wrong password"). */
  noRefresh?: boolean;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const send = () => {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    return fetch(`/api${path}`, {
      method: opts.method ?? 'GET',
      headers,
      credentials: 'include',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  };

  let res = await send();
  if (res.status === 401 && !opts.noRefresh) {
    const token = await refreshAccessToken();
    if (token) {
      res = await send(); // retry once with the new token
    } else {
      onSessionLost();
    }
  }
  const body = await parse(res);
  if (!res.ok) throw toError(res, body);
  return body as T;
}

/** A fresh random key, made once per button press, so a retry of the SAME press can never create a duplicate. */
export const newIdempotencyKey = () => crypto.randomUUID();


/** A message that is safe to show a person, whatever went wrong. */
export const errorMessage = (e: unknown): string =>
  e instanceof ApiError ? e.message : 'Cannot reach the server. Check your connection and try again.';