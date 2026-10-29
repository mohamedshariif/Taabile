import { describe, expect, it } from 'vitest';
import type { OpenDocument } from '../api/types';
import { checkPayAmount, payBody, payProblems, previewApply, totalOwed, type PayDraft } from './payments';

const doc = (id: string, owed: string): OpenDocument => ({ kind: 'SALE', id, number: `INV-${id}`, date: '2026-10-01T00:00:00Z', dueDate: null, total: owed, paid: '0', owed, overdue: false });
const items = [doc('1', '60.0000'), doc('2', '80.0000')];
const draft = (over: Partial<PayDraft> = {}): PayDraft => ({ partyId: 'c1', accountId: 'a1', amount: '100', reference: '', note: '', only: '', ...over });

describe('payment helpers', () => {
  it('amounts: above zero, 2 decimals', () => {
    expect(checkPayAmount('10')).toBeUndefined();
    expect(checkPayAmount('10.50')).toBeUndefined();
    for (const bad of ['', '0', '-1', '1.005', 'abc']) expect(checkPayAmount(bad)).toBeTruthy();
  });

  it('pays the oldest first, and shows what is left over', () => {
    expect(previewApply('100', items)).toEqual({ applied: [{ id: '1', number: 'INV-1', amount: '60.00', settles: true }, { id: '2', number: 'INV-2', amount: '40.00', settles: false }], left: '0.00' });
    expect(previewApply('150', items).left).toBe('10.00');
    expect(previewApply('30', items, '2').applied).toEqual([{ id: '2', number: 'INV-2', amount: '30.00', settles: false }]);
    expect(totalOwed(items)).toBe('140.00');
  });

  it('what stops the Save button', () => {
    expect(payProblems(draft(), items, 'customer')).toEqual([]);
    expect(payProblems(draft({ partyId: '', accountId: '' }), items, 'supplier')).toEqual(['Choose a supplier', 'Choose the cash drawer or bank account']);
    expect(payProblems(draft({ amount: '150' }), items, 'customer')[0]).toMatch(/more than is owed \(140.00\)/);
    expect(payProblems(draft({ amount: '90', only: '1' }), items, 'customer')[0]).toMatch(/more than this document/);
  });

  it('the request: oldest first unless one document is chosen', () => {
    expect(payBody(draft({ reference: ' TRF-1 ' }), 'customer')).toEqual({ customerId: 'c1', financialAccountId: 'a1', amount: '100', reference: 'TRF-1' });
    expect(payBody(draft({ amount: '30', only: '2' }), 'supplier')).toEqual({ supplierId: 'c1', financialAccountId: 'a1', amount: '30', allocations: [{ receiptId: '2', amount: '30' }] });
  });
});