import { useMe } from '../../auth/AuthContext';
import { Muted, PageTitle, SectionTitle } from '../../components/ui';

export function HomePage() {
  const me = useMe();
  return (
    <>
      <PageTitle>Welcome, {me.user.name}</PageTitle>
      <Muted>
        {me.company.name} · {me.company.currency} · {me.role}
      </Muted>
      <SectionTitle>What you may do</SectionTitle>
      <Muted small>This list comes straight from the server (GET /api/auth/me). The menu is built from it.</Muted>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {Object.entries(me.permissions).map(([p, scope]) => (
          <li key={p} className="min-w-0 rounded-lg border border-line bg-card px-3 py-2 wrap-break-word">
            <code>{p}</code> <span className="text-sm text-muted">({scope})</span>
          </li>
        ))}
      </ul>
    </>
  );
}