import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { InvitationPreview } from '../api/types';
import { useAuth } from '../auth/AuthContext';

// Opened from the link in the invitation email:  /accept-invite?token=...
export function AcceptInvitePage() {
  const token = useSearchParams()[0].get('token') ?? '';
  const { state, adoptToken } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api<InvitationPreview>(`/invitations/by-token/${encodeURIComponent(token)}`, { noRefresh: true }),
    enabled: token.length > 0,
    retry: false,
  });

  async function accept(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // A new person sends name + password. Someone who already has an account sends neither:
      // they must be signed in, and the server then recognises them from the access token.
      const body = preview.data?.accountExists ? { token } : { token, name, password };
      const res = await api<{ accessToken: string }>('/invitations/accept', { method: 'POST', body });
      await adoptToken(res.accessToken);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cannot reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!token) return 
  <Box>
    <p className="error">This link is incomplete. Ask your Admin to send a new invitation.
      </p>
  </Box>;
  if (preview.isLoading) return <Box><p className="muted">Checking your invitation…</p></Box>;
  if (preview.isError) {
    return (
      <Box>
        <h1>Invitation not valid</h1>
        <p>This link was already used, has expired, or was cancelled. Ask your Admin to send a new one.</p>
      </Box>
    );
  }
  const inv = preview.data!;

  return (
    <Box>
      <h1>Join {inv.companyName}</h1>
      <p>
        {inv.inviterName ?? 'Your Admin'} invited <strong>{inv.email}</strong> as <strong>{inv.role}</strong>.
      </p>
      {inv.accountExists ? (
        state.status === 'signedIn' ? (
          <form onSubmit={(e) => void accept(e)}>
            <button disabled={busy}>{busy ? 'Joining…' : `Join ${inv.companyName}`}</button>
          </form>
        ) : (
          <p>
            You already have a Taabile account. <Link to="/login" state={{ from: `/accept-invite?token=${token}` }}>Sign in</Link>{' '}
            first, then this page will let you join.
          </p>
        )
      ) : (
        <form onSubmit={(e) => void accept(e)}>
          <label>
            Your name
            <input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Choose a password
            <input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
            <span className="muted small">At least 10 characters. Nobody, not even your Admin, can see it.</span>
          </label>
          <button disabled={busy}>{busy ? 'Creating account…' : 'Create my account'}</button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </Box>
  );
}

const Box = ({ children }: { children: React.ReactNode }) => (
  <div className="center">
    <div className="card narrow">{children}</div>
  </div>
);