import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, refreshAccessToken, setAccessToken, setSessionLostHandler } from '../api/client';
import type { CompanyChoice, LoginResponse, Me } from '../api/types';

type State = { status: 'loading' } | { status: 'anonymous' } | { status: 'signedIn'; me: Me };

interface AuthApi {
  state: State;
  /** Returns 'ok', or the companies to pick from when the person belongs to several. */
  login(email: string, password: string, companyId?: string): Promise<{ next: 'ok' } | { next: 'choose'; companies: CompanyChoice[] }>;
  /** Used after accepting an invitation: the server already gave us an access token. */
  adoptToken(accessToken: string): Promise<void>;
  logout(): Promise<void>;
  /** Does the signed-in person have this permission at all? (The server still checks every request.) */
  can(permission: string): boolean;
}

const Ctx = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const queryClient = useQueryClient();

  const loadMe = useCallback(async () => {
    const me = await api<Me>('/auth/me');
    setState({ status: 'signedIn', me });
  }, []);

  // On page load: do we still have a valid refresh cookie? If so we are signed in without typing a password.
  useEffect(() => {
    setSessionLostHandler(() => {
      setAccessToken(null);
      queryClient.clear();
      setState({ status: 'anonymous' });
    });
    let cancelled = false;
    (async () => {
      const token = await refreshAccessToken();
      if (cancelled) return;
      if (!token) return setState({ status: 'anonymous' });
      try {
        await loadMe();
      } catch {
        if (!cancelled) setState({ status: 'anonymous' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe, queryClient]);

  const login: AuthApi['login'] = async (email, password, companyId) => {
    const res = await api<LoginResponse>('/auth/login', {
      method: 'POST',
      body: { email, password, ...(companyId ? { companyId } : {}) },
      noRefresh: true,
    });
    if (res.status === 'choose_company') return { next: 'choose', companies: res.companies };
    setAccessToken(res.accessToken);
    await loadMe();
    return { next: 'ok' };
  };

  const adoptToken: AuthApi['adoptToken'] = async (token) => {
    setAccessToken(token);
    await loadMe();
  };

  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST', noRefresh: true });
    } finally {
      setAccessToken(null);
      queryClient.clear(); // forget every cached screen so the next person never sees old data
      setState({ status: 'anonymous' });
    }
  };

  const value = useMemo<AuthApi>(
    () => ({
      state,
      login,
      adoptToken,
      logout,
      can: (p) => state.status === 'signedIn' && p in state.me.permissions,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}

/** The signed-in person. Only call this on screens that are behind <RequireAuth>. */
export function useMe(): Me {
  const { state } = useAuth();
  if (state.status !== 'signedIn') throw new Error('useMe needs a signed-in user');
  return state.me;
}