import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import type { CompanyChoice } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, Center, ErrorText, Field, Input, Muted } from '../components/ui';

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
    <Center>
      <Card as="form" className="w-full max-w-sm" onSubmit={(e) => void submit(e)}>
        <h1 className="mb-3 text-2xl font-bold">Sign in to Taabile</h1>
        {choices ? (
          <div className="space-y-2">
            <p>You belong to more than one company. Which one do you want to open?</p>
            {choices.map((c) => (
              <Button key={c.id} variant="choice" disabled={busy} onClick={(e) => void submit(e, c.id)}>
                {c.name} <Muted small className="ml-2">{c.role}</Muted>
              </Button>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="Email">
              <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password">
              <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
          </div>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </Card>
    </Center>
  );
}