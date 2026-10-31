import type { ReactNode } from 'react';
import { Button, Card, Field, FieldRow, Input, Muted, Select } from '../../components/ui';
import { agrees, downloadCsv, localToday, PRESET_LABEL, presetRange, rangeProblem, toCsv, type Preset } from '../../lib/reports';
import { money } from '../../lib/stock';
import { useLocations } from '../../features/stock/hooks';

/** One headline number. */
export function Stat({ label, value, hint, wide }: { label: string; value: ReactNode; hint?: ReactNode; wide?: boolean }) {
  return (
    <div className={`min-w-0 rounded-xl border border-line bg-card p-4 ${wide ? 'sm:col-span-2' : ''}`}>
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-1 text-2xl font-bold wrap-break-word">{value}</div>
      {hint && <div className="mt-1 text-sm text-muted">{hint}</div>}
    </div>
  );
}
export const StatGrid = ({ children }: { children: ReactNode }) => <div className="my-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;

export interface RangeState { from: string; to: string; locationId: string }

/** Quick ranges, two dates, and (when the person has more than one place) a place. */
export function RangeBar({ value, onChange, permission, withPlace = true, withDates = true }: {
  value: RangeState; onChange: (v: RangeState) => void; permission: string; withPlace?: boolean; withDates?: boolean;
}) {
  const { usable } = useLocations(permission);
  const problem = withDates ? rangeProblem(value.from, value.to) : undefined;
  const set = (p: Partial<RangeState>) => onChange({ ...value, ...p });
  return (
    <Card>
      {withDates && (
        <div className="flex flex-wrap gap-2">
          {(Object.keys(PRESET_LABEL) as Preset[]).map((p) => (
            <Button key={p} type="button" variant="ghost" onClick={() => set(presetRange(p, localToday()))}>{PRESET_LABEL[p]}</Button>
          ))}
        </div>
      )}
      <FieldRow>
        {withDates && <Field label="From" error={problem}><Input type="date" value={value.from} onChange={(e) => set({ from: e.target.value })} /></Field>}
        {withDates && <Field label="To"><Input type="date" value={value.to} onChange={(e) => set({ to: e.target.value })} /></Field>}
        {withPlace && usable.length > 1 && (
          <Field label="Place">
            <Select value={value.locationId} onChange={(e) => set({ locationId: e.target.value })}>
              <option value="">All places</option>
              {usable.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
        )}
      </FieldRow>
    </Card>
  );
}

export const queryString = (o: Record<string, string | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
};

export function CsvButton({ name, headers, rows, disabled }: { name: string; headers: string[]; rows: (string | number | null)[][]; disabled?: boolean }) {
  return <Button type="button" variant="ghost" disabled={disabled || rows.length === 0} onClick={() => downloadCsv(`${name}.csv`, toCsv(headers, rows))}>Download CSV</Button>;
}

/** Whether the report and the accounting books say the same. A difference is shown, never hidden. */
export function LedgerCheck({ difference, what }: { difference: string | null; what: string }) {
  if (difference === null) return null;
  return agrees(difference)
    ? <Muted small>✓ {what} matches the accounting books.</Muted>
    : <p className="my-2 rounded-lg border border-warn p-3 text-warn">{what} differs from the accounting books by {money(String(Math.abs(Number(difference))))}. Opening balances or a manual journal can cause this: ask whoever keeps your accounts.</p>;
}