import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage, newIdempotencyKey } from '../../api/client';
import type { Customer, Supplier } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, ErrorText, PageTitle } from '../../components/ui';
import { customerBody, emptyParty, hasProblems, supplierBody, validateParty, type PartyDraft, type PartyKind } from '../../lib/parties';
import { PartyFields } from '../../features/parties/PartyForm';
import { KINDS } from '../../features/parties/kinds';

export function PartyNewPage({ kind }: { kind: PartyKind }) {
  const k = KINDS[kind];
  const { can } = useAuth();
  const canCredit = kind === 'customer' && can('credit.manage');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<PartyDraft>(emptyParty);
  const [attempted, setAttempted] = useState(false);

  // One key per version of the form: pressing Save twice, or retrying after a bad connection, can never create two records.
  const key = useRef(newIdempotencyKey());
  const change = (patch: Partial<PartyDraft>) => {
    key.current = newIdempotencyKey();
    setDraft((d) => ({ ...d, ...patch }));
  };

  const problems = validateParty(draft);
  const create = useMutation({
    mutationFn: () =>
      api<{ customer?: Customer; supplier?: Supplier }>(`/${k.path}`, {
        method: 'POST',
        body: kind === 'customer' ? customerBody(draft, canCredit) : supplierBody(draft),
        idempotencyKey: key.current,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: [k.path] });
      navigate(`/${k.path}/${(r.customer ?? r.supplier)!.id}`, { replace: true });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (!hasProblems(problems)) create.mutate();
  };

  return (
    <>
      <p className="mb-2"><Link to={`/${k.path}`}>← All {k.plural.toLowerCase()}</Link></p>
      <PageTitle>New {k.one}</PageTitle>
      <Card as="form" onSubmit={submit}>
        <PartyFields kind={kind} draft={draft} onChange={change} problems={attempted ? problems : {}} canCredit={canCredit} />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Saving…' : `Create ${k.one}`}</Button>
          <Button variant="ghost" onClick={() => navigate(`/${k.path}`)}>Cancel</Button>
        </div>
        {attempted && hasProblems(problems) && <ErrorText>Some fields need your attention (marked in red above).</ErrorText>}
        {create.isError && <ErrorText>{errorMessage(create.error)}</ErrorText>}
      </Card>
    </>
  );
}