import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import { Button, Card, ErrorText, Field, Input, Muted, PageTitle, Select } from '../../components/ui';
import { checkCost, linesHaveProblems, openingBody, type DraftLine } from '../../lib/stock';
import { LinesEditor } from '../../features/stock/LinesEditor';
import { useIdempotencyKey, useLocations } from '../../features/stock/hooks';

// The starting balance, from your count. Admin only. It must be the first entry for a product at a place.
export function OpeningStockPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { usable, isLoading } = useLocations('import.run');
  const [locationId, setLocationId] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!locationId && usable.length === 1) setLocationId(usable[0]!.id);
  }, [usable, locationId]);

  const keyFor = useIdempotencyKey();
  const save = useMutation({
    mutationFn: () => {
      const body = openingBody(locationId, lines, note);
      return api('/stock/opening', { method: 'POST', body, idempotencyKey: keyFor(body) });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stock'] });
      void qc.invalidateQueries({ queryKey: ['stock-movements'] });
      navigate('/stock');
    },
  });
  const ready = !!locationId && !linesHaveProblems(lines, checkCost);

  return (
    <>
      <p className="mb-2"><Link to="/stock">← Stock</Link></p>
      <PageTitle>Opening stock</PageTitle>
      <Muted>
        Count what is on the shelves and enter it here, one place at a time. Type quantities in any unit (for example 20 sacks) and what one of that unit cost you.
        A product that already has stock history at this place cannot get opening stock again.
      </Muted>

      <Card as="form" onSubmit={(e) => { e.preventDefault(); if (ready) save.mutate(); }}>
        <Field label="Where is this stock?" className="block max-w-sm">
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={isLoading}>
            <option value="">Choose a place</option>
            {usable.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <div className="mt-4">
          <LinesEditor lines={lines} onChange={setLines} priceLabel="Cost of one unit" priceHint="What one of this unit cost you. 0 if unknown." priceCheck={checkCost} />
        </div>
        <Field label="Note (optional)" className="mt-4 block">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="For example: count of 1 October" />
        </Field>
        <div className="mt-4">
          <Button type="submit" disabled={!ready || save.isPending}>{save.isPending ? 'Saving…' : 'Save opening stock'}</Button>
        </div>
        {save.isError && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      </Card>
    </>
  );
}