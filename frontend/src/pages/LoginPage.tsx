import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import type { CompanyChoice } from '../api/types';
import { useAuth } from '../auth/AuthContext';

export function LoginPage() {
  const { state, login } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [choices, setChoices] = useState<CompanyChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state.status === 'signedIn') return <Navigate to={from} replace />;

  async function submit(e: FormEvent, companyId?: string) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await login(email, password, companyId);
      if (r.next === 'choose') setChoices(r.companies);
      else navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cannot reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card narrow" onSubmit={(e) => void submit(e)}>
        <h1>Sign in to Taabile</h1>
        {choices ? (
          <>
            <p>You belong to more than one company. Which one do you want to open?</p>
            {choices.map((c) => (
              <button key={c.id} type="button" className="choice" disabled={busy} onClick={(e) => void submit(e, c.id)}>
                {c.name} <span className="muted small">{c.role}</span>
              </button>
            ))}
          </>
        ) : (
          <>
            <label>
              Email
              <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label>
              Password
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </div>
  );
}