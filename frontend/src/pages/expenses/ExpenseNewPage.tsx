import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { CashChoice, Expense } from '../../api/types';
import { useMe } from '../../auth/AuthContext';
import { Button, Card, ErrorText, Field, FieldRow, Input, Muted, PageTitle, Select } from '../../components/ui';
import { expenseBody, expenseProblems, type ExpenseDraft } from '../../lib/cash';
import { useIdempotencyKey, useLocations } from '../../features/stock/hooks';

export function ExpenseNewPage() {
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { usable } = useLocations('expenses.create');
  const companyWide = me.permissions['expenses.create'] === 'company';
  const [d, setD] = useState<ExpenseDraft>({ categoryId: '', amount: '', description: '', accountId: '', locationId: '', date: '' });
  const set = (patch: Partial<ExpenseDraft>) => setD((x) => ({ ...x, ...patch }));
  useEffect(() => {
    if (!d.locationId && !companyWide && usable.length === 1) setD((x) => ({ ...x, locationId: usable[0]!.id }));
  }, [usable, d.locationId, companyWide]);

  const cats = useQuery({ queryKey: ['expense-categories'], queryFn: () => api<{ categories: { id: string; name: string }[] }>('/expenses/categories') });
  const accounts = useQuery({ queryKey: ['cash-choices'], queryFn: () => api<{ from: CashChoice[]; to: CashChoice[] }>('/cash/accounts'), retry: false });
  const problems = expenseProblems(d, !companyWide);
  const keyFor = useIdempotencyKey();
  const save = useMutation({
    mutationFn: () => {
      const body = expenseBody(d);
      return api<{ expense: Expense }>('/expenses', { method: 'POST', body, idempotencyKey: keyFor(body) });
    },
    onSuccess: (r) => {
      for (const k of ['expenses', 'money-accounts', 'cash-choices']) void qc.invalidateQueries({ queryKey: [k] });
      navigate(`/expenses/${r.expense.id}`);
    },
  });
  return (
    <>
      <p className="mb-2"><Link to="/expenses">← Expenses</Link></p>
      <PageTitle>New expense</PageTitle>
      <Muted>The money leaves the account you choose right away. You cannot spend more than the account holds.</Muted>
      <Card as="form" onSubmit={(e) => { e.preventDefault(); if (!problems.length) save.mutate(); }}>
        <FieldRow>
          <Field label="Kind of cost">
            <Select value={d.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
              <option value="">Choose…</option>
              {(cats.data?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Amount (USD)"><Input value={d.amount} inputMode="decimal" onChange={(e) => set({ amount: e.target.value })} /></Field>
        </FieldRow>
        <Field label="What was it for?" className="block"><Input value={d.description} maxLength={200} onChange={(e) => set({ description: e.target.value })} placeholder="Fuel for the Juba truck" /></Field>
        <FieldRow>
          <Field label="Paid from">
            <Select value={d.accountId} onChange={(e) => set({ accountId: e.target.value })}>
              <option value="">Choose an account</option>
              {(accounts.data?.from ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label="Place this cost belongs to">
            <Select value={d.locationId} onChange={(e) => set({ locationId: e.target.value })}>
              {companyWide && <option value="">Company-wide</option>}
              {!companyWide && <option value="">Choose a place</option>}
              {usable.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          <Field label="Date (optional)" hint="Leave empty for today"><Input type="date" value={d.date} onChange={(e) => set({ date: e.target.value })} /></Field>
        </FieldRow>
        {accounts.isError && <ErrorText>{errorMessage(accounts.error)}</ErrorText>}
        {d.amount.trim() !== '' && problems.length > 0 && <Muted small className="mt-3">{problems.join('. ')}.</Muted>}
        <div className="mt-4"><Button type="submit" disabled={problems.length > 0 || save.isPending}>{save.isPending ? 'Saving…' : 'Save expense'}</Button></div>
        {save.isError && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      </Card>
    </>
  );
}