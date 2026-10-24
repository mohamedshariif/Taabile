import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { PriceList } from '../../api/types';
import { Field, FieldRow, Input, Muted, Select } from '../../components/ui';
import { creditText, type PartyDraft, type PartyKind, type PartyProblems } from '../../lib/parties';

// The fields of a customer or supplier. Used by the "new" page and the detail page.
//   canCredit: may this person set the credit limit and payment terms of a CUSTOMER? (credit.manage)
//   Suppliers' payment terms are ordinary details, so anyone who manages suppliers can set them.
export function PartyFields({
  kind,
  draft,
  onChange,
  problems,
  canCredit,
  savedCredit,
}: {
  kind: PartyKind;
  draft: PartyDraft;
  onChange: (patch: Partial<PartyDraft>) => void;
  problems: PartyProblems;
  canCredit: boolean;
  /** Edit screen only: the saved credit, shown as plain text to people who may not change it. */
  savedCredit?: { limit: string | null; days: number };
}) {
  const lists = useQuery({ queryKey: ['price-lists'], queryFn: () => api<{ priceLists: PriceList[] }>('/price-lists'), enabled: kind === 'customer' });
  const activeLists = (lists.data?.priceLists ?? []).filter((l) => l.status === 'ACTIVE' || l.id === draft.priceListId);

  return (
    <>
      <FieldRow>
        <Field label="Name" error={problems.name}>
          <Input value={draft.name} onChange={(e) => onChange({ name: e.target.value })} maxLength={120} placeholder={kind === 'customer' ? 'Mary Store' : 'Juba Sugar Ltd'} />
        </Field>
        <Field label="Code (optional)" hint="Leave empty and Taabile makes one." error={problems.code}>
          <Input value={draft.code} onChange={(e) => onChange({ code: e.target.value })} maxLength={30} />
        </Field>
        <Field label="Phone (optional)" error={problems.phone}>
          <Input value={draft.phone} onChange={(e) => onChange({ phone: e.target.value })} inputMode="tel" placeholder="+211 912 345 678" />
        </Field>
      </FieldRow>
      <Field label="Address (optional)">
        <Input value={draft.address} onChange={(e) => onChange({ address: e.target.value })} maxLength={300} />
      </Field>

      {kind === 'customer' && (
        <Field label="Price list" hint="Which selling prices this customer gets. Empty = the company default (Retail)." className="mt-3 block max-w-xs">
          <Select value={draft.priceListId} onChange={(e) => onChange({ priceListId: e.target.value })}>
            <option value="">Default price list</option>
            {activeLists.map((l) => (
              <option key={l.id} value={l.id}>{l.name}{l.status === 'ACTIVE' ? '' : ' (switched off)'}</option>
            ))}
          </Select>
        </Field>
      )}

      {kind === 'customer' && !canCredit && (
        <Muted small className="mt-3">
          {savedCredit ? `Credit: ${creditText(savedCredit.limit, savedCredit.days)}. ` : 'New customers start as cash only. '}
          Only people allowed to manage credit can change the credit limit and payment terms.
        </Muted>
      )}
      {(kind === 'supplier' || canCredit) && (
        <FieldRow>
          {kind === 'customer' && (
            <Field label="Credit limit" hint="How much they may owe at most. Empty = cash only, no credit." error={problems.creditLimit}>
              <Input value={draft.creditLimit} onChange={(e) => onChange({ creditLimit: e.target.value })} inputMode="decimal" placeholder="Cash only" />
            </Field>
          )}
          <Field
            label="Payment terms (days)"
            hint={kind === 'customer' ? 'Days they have to pay after a credit sale. 0 = pay at once.' : 'Days the supplier gives us to pay. 0 = pay at once.'}
            error={problems.paymentTermsDays}
          >
            <Input value={draft.paymentTermsDays} onChange={(e) => onChange({ paymentTermsDays: e.target.value })} inputMode="numeric" />
          </Field>
        </FieldRow>
      )}
    </>
  );
}