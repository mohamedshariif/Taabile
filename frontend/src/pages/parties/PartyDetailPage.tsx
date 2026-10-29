import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { Customer, Supplier } from '../../api/types';
import { useAuth, useMe } from '../../auth/AuthContext';
import { Badge, Button, Card, ErrorText, Muted, PageTitle, SectionTitle } from '../../components/ui';
import { changedFields, customerBody, describeBalance, draftFrom, hasProblems, savedAsBody, supplierBody, validateParty, type PartyDraft, type PartyKind } from '../../lib/parties';
import { PartyFields } from '../../features/parties/PartyForm';
import { KINDS } from '../../features/parties/kinds';

type Party = Customer | Supplier;

export function PartyDetailPage({ kind }: { kind: PartyKind }) {
  const k = KINDS[kind];
  const { id = '' } = useParams();
  const { can } = useAuth();
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canManage = can(k.manage);
  const canCredit = kind === 'customer' && can('credit.manage');

  const detail = useQuery({ queryKey: [k.path, id], queryFn: () => api<{ customer?: Customer; supplier?: Supplier }>(`/${k.path}/${id}`) });
  const party: Party | undefined = detail.data?.customer ?? detail.data?.supplier;

  const [draft, setDraft] = useState<PartyDraft | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (party) setDraft(draftFrom(party));
  }, [party]);

  const put = (r: { customer?: Customer; supplier?: Supplier }) => {
    qc.setQueryData([k.path, id], r);
    void qc.invalidateQueries({ queryKey: [k.path] });
  };
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ customer?: Customer; supplier?: Supplier }>(`/${k.path}/${id}`, { method: 'PATCH', body }),
    onSuccess: (r) => {
      put(r);
      setSaved(true);
    },
  });
  const setStatus = useMutation({
    mutationFn: (status: 'ACTIVE' | 'INACTIVE') => api<{ customer?: Customer; supplier?: Supplier }>(`/${k.path}/${id}`, { method: 'PATCH', body: { status } }),
    onSuccess: put,
  });
  const remove = useMutation({
    mutationFn: () => api(`/${k.path}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: [k.path, id] });
      void qc.invalidateQueries({ queryKey: [k.path] });
      navigate(`/${k.path}`, { replace: true });
    },
  });

  if (detail.isLoading || (party && !draft)) return <Muted>Loading…</Muted>;
  if (detail.isError || !party || !draft) return <ErrorText>{errorMessage(detail.error)}</ErrorText>;

  const problems = validateParty(draft);
  const body = kind === 'customer' ? customerBody(draft, canCredit) : supplierBody(draft);
  const changes = changedFields(body, savedAsBody(party, canCredit));
  const dirty = Object.keys(changes).length > 0;
  const active = party.status === 'ACTIVE';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    if (!hasProblems(problems) && dirty) save.mutate(changes);
  };

  return (
    <>
      <p className="mb-2"><Link to={`/${k.path}`}>← All {k.plural.toLowerCase()}</Link></p>
      <PageTitle>{party.name}</PageTitle>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
        <code>{party.code}</code> · <Badge tone={active ? 'ok' : 'off'}>{active ? 'Active' : 'Switched off'}</Badge>
      </p>
      <Card className="mt-4">
        <div className="text-sm text-muted">Balance</div>
        {/* <div className="text-xl font-bold">{describeBalance(kind, party.balance, me.company.currency)}</div>
      </Card> */}
        <div className="text-xl font-bold">
          {describeBalance(kind, party.balance, me.company.currency)}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {can('payments.view') && <Button variant="ghost" small onClick={() => navigate(`/${k.path}/${id}/statement`)}>Statement</Button>}
          {kind === 'customer' && can('payments.receive') && <Button small onClick={() => navigate(`/payments/receive?customerId=${id}`)}>Take payment</Button>}
          {kind === 'supplier' && can('payments.pay_supplier') && <Button small onClick={() => navigate(`/payments/pay?supplierId=${id}`)}>Pay supplier</Button>}
        </div>
      </Card>

      {canManage ? (
        <Card as="form" onSubmit={submit}>
          <SectionTitle first>Details</SectionTitle>
          <PartyFields
            kind={kind}
            draft={draft}
            onChange={(patch) => {
              setSaved(false);
              setDraft({ ...draft, ...patch });
            }}
            problems={problems}
            canCredit={canCredit}
            savedCredit={kind === 'customer' ? { limit: (party as Customer).creditLimit, days: party.paymentTermsDays } : undefined}
          />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={save.isPending || !dirty || hasProblems(problems)}>{save.isPending ? 'Saving…' : 'Save details'}</Button>
            {saved && !dirty && <span className="font-medium text-brand">Saved.</span>}
          </div>
          {save.isError && <ErrorText>{errorMessage(save.error)}</ErrorText>}
        </Card>
      ) : (
        <Card>
          <SectionTitle first>Details</SectionTitle>
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
            <dt className="text-muted">Phone</dt><dd>{party.phone ?? '—'}</dd>
            <dt className="text-muted">Address</dt><dd>{party.address ?? '—'}</dd>
            {kind === 'customer' && <><dt className="text-muted">Price list</dt><dd>{(party as Customer).priceList?.name ?? 'Default'}</dd></>}
            <dt className="text-muted">Payment terms</dt><dd>{party.paymentTermsDays ? `${party.paymentTermsDays} days` : 'Pay at once'}</dd>
          </dl>
        </Card>
      )}

      {canManage && (
        <Card>
          <SectionTitle first>{active ? `Switch off this ${k.one}` : `Switch this ${k.one} back on`}</SectionTitle>
          <Muted small className="mb-3">
            {active
              ? `A switched-off ${k.one} cannot be chosen on new documents, but all history stays. Not possible while there is an open balance.`
              : `It will appear again when choosing a ${k.one}.`}
          </Muted>
          <Button variant="ghost" disabled={setStatus.isPending} onClick={() => setStatus.mutate(active ? 'INACTIVE' : 'ACTIVE')}>
            {active ? 'Switch off' : 'Switch on'}
          </Button>
          {setStatus.isError && <ErrorText>{errorMessage(setStatus.error)}</ErrorText>}
        </Card>
      )}

      {can('records.delete') && (
        <Card className="border-danger">
          <SectionTitle first className="text-danger">Delete this {k.one}</SectionTitle>
          <Muted small className="mb-3">
            Only for a record created by mistake that has never been used. If there are any sales, purchases, payments or accounting entries, deleting is refused and you should switch it off instead. This cannot be undone.
          </Muted>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(`Permanently delete "${party.name}"? This cannot be undone.`)) remove.mutate();
            }}
          >
            {remove.isPending ? 'Deleting…' : `Delete ${k.one}`}
          </Button>
          {remove.isError && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
        </Card>
      )}
    </>
  );
}