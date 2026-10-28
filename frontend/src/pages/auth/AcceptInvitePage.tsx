import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import type { InvitationPreview } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Center, ErrorText, Field, Input, Muted } from '../../components/ui';

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

    if (!token) return <Box><ErrorText>This link is incomplete. Ask your Admin to send a new invitation.</ErrorText></Box>;
  if (preview.isLoading) return <Box><Muted>Checking your invitation…</Muted></Box>;
  if (preview.isError) {
    return (
      <Box>
        <Title>Invitation not valid</Title>
        <p>This link was already used, has expired, or was cancelled. Ask your Admin to send a new one.</p>
      </Box>
    );
  }
  const inv = preview.data!;

  return (
    <Box>
      <Title>Join {inv.companyName}</Title>
      <p>
        {inv.inviterName ?? 'Your Admin'} invited <strong>{inv.email}</strong> as <strong>{inv.role}</strong>.
      </p>
      {inv.accountExists ? (
        state.status === 'signedIn' ? (
          <form className="mt-4" onSubmit={(e) => void accept(e)}>
            <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Joining…' : `Join ${inv.companyName}`}</Button>
          </form>
        ) : (
          <p className="mt-3">
            You already have a Taabile account. <Link to="/login" state={{ from: `/accept-invite?token=${token}` }}>Sign in</Link>{' '}
            first, then this page will let you join.
          </p>
        )
      ) : (
        <form className="mt-4 space-y-4" onSubmit={(e) => void accept(e)}>
          <Field label="Your name">
            <Input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Choose a password" hint="At least 10 characters. Nobody, not even your Admin, can see it.">
            <Input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Creating account…' : 'Create my account'}</Button>
        </form>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </Box>
  );
}

const Title = ({ children }: { children: React.ReactNode }) => <h1 className="mb-3 text-2xl font-bold">{children}</h1>;

const Box = ({ children }: { children: React.ReactNode }) => (
  <Center theme>
    <Card className="w-full max-w-sm">{children}</Card>
  </Center>
);