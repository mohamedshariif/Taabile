import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { StockCount } from '../../api/types';
import { Button, Card, ErrorText, Field, Input, Muted, PageTitle, Select } from '../../components/ui';
import { checkPrice, countBody, countProblems, type DraftLine } from '../../lib/stock';
import { LinesEditor } from '../../features/stock/LinesEditor';
import { useIdempotencyKey, useLocations } from '../../features/stock/hooks';

// Count what is really on the shelf. The system's figure is NOT shown here on purpose: count first, compare after.
export function CountNewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { usable, isLoading } = useLocations('stock.count');
  const [locationId, setLocationId] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!locationId && usable.length === 1) setLocationId(usable[0]!.id);
  }, [usable, locationId]);
  const keyFor = useIdempotencyKey();
  const save = useMutation({
    mutationFn: () => {
      const body = countBody(locationId, lines, note);
      return api<{ count: StockCount }>('/counts', { method: 'POST', body, idempotencyKey: keyFor(body) });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['counts'] });
      navigate(`/counts/${r.count.id}`);
    },
  });
  const problems = countProblems(locationId, lines);
  return (
    <>
      <p className="mb-2">
        <Link to="/counts">← Stock counts</Link>
      </p>
      <PageTitle>New stock count</PageTitle>
      <Muted>
        Add each product you counted and type how much is really there (0 for an empty shelf). Nothing changes until a Manager or Admin approves the count
      </Muted>
      <Card as="form" onSubmit={(e) => { e.preventDefault(); if (!problems.length) save.mutate(); }}>
        <Field label="Where did you count?" className="block max-w-sm">
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={isLoading}>
            <option value="">Choose a place</option>
            {usable.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <div className="mt-4">
          <LinesEditor lines={lines} onChange={setLines} priceLabel="" priceCheck={checkPrice} withPrice={false} qtyLabel="Counted" allowZero withReason />
        </div>
        <Field label="Note (optional)" className="mt-4 block">
          <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {problems.length > 0 && lines.length > 0 && <Muted small className="mt-3">{problems.join('. ')}.</Muted>}
        <div className="mt-4">
          <Button
            type="submit"
            disabled={problems.length > 0 || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Submit count'}
          </Button>
        </div>
        {save.isError && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      </Card>
    </>
  );
}