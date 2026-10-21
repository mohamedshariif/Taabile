import { useMe } from '../auth/AuthContext';

export function HomePage() {
  const me = useMe();
  return (
    <>
      <h1>Welcome, {me.user.name}</h1>
      <p className="muted">
        {me.company.name} · {me.company.currency} · {me.role}
      </p>
      <h2>What you may do</h2>
      <p className="small muted">This list comes straight from the server (GET /api/auth/me). The menu on the left is built from it.</p>
      <ul className="perms">
        {Object.entries(me.permissions).map(([p, scope]) => (
          <li key={p}>
            <code>{p}</code> <span className="muted small">({scope})</span>
          </li>
        ))}
      </ul>
    </>
  );
}