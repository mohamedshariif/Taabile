import { describe, expect, it } from 'vitest';
import type { ProductSummary } from '../api/types';
import { lineProblem, newOther, newPay, newSaleLine, quoteBody, readyToQuote, saleBody, saleProblems, type SaleDraft } from './sales';

const unit = (id: string, name: string, factor: string, isBase = false) => ({ id, name, factor, isBase, isPurchaseUnit: true, isSaleUnit: true, barcode: null, status: 'ACTIVE' as const });
const sugar: ProductSummary = { id: 'p1', sku: 'P-1', name: 'Sugar', status: 'ACTIVE', category: null, baseUnit: 'kg', allowFractions: true, units: [unit('u1', 'kg', '1', true), unit('u2', 'Sack 50 kg', '50')] };
const draft = (over: Partial<SaleDraft> = {}): SaleDraft => ({ locationId: 'A', customerId: '', lines: [{ ...newSaleLine(sugar), qty: '10' }], payments: [], note: '', ...over });

describe('sales till', () => {
  it('starts in the base unit', () => expect(newSaleLine(sugar).unitId).toBe('u1'));

  it('the request leaves out an empty price and empty other places', () => {
    expect(quoteBody(draft()).lines[0]).toEqual({ productId: 'p1', unitId: 'u1', quantity: '10' });
    const l = { ...draft().lines[0]!, price: '2.5', other: [{ ...newOther(), locationId: 'W', qty: '4' }, newOther()] };
    expect(quoteBody(draft({ lines: [l] })).lines[0]).toEqual({ productId: 'p1', unitId: 'u1', quantity: '10', unitPrice: '2.5', fromOther: [{ locationId: 'W', quantity: '4' }] });
  });

  it('payments with no account are not sent', () => {
    const d = draft({ customerId: 'c1', payments: [newPay('acc', '20'), newPay('', '')] });
    expect(saleBody(d).payments).toEqual([{ financialAccountId: 'acc', amount: '20' }]);
    expect(saleBody(d).customerId).toBe('c1');
  });

  it('spots bad lines', () => {
    const l = draft().lines[0]!;
    expect(lineProblem(l)).toBeUndefined();
    expect(lineProblem({ ...l, qty: '' })).toBeTruthy();
    expect(lineProblem({ ...l, price: 'abc' })).toBeTruthy();
    expect(lineProblem({ ...l, other: [{ ...newOther(), locationId: 'W', qty: '11' }] })).toMatch(/More is taken/);
    expect(lineProblem({ ...l, other: [{ ...newOther(), qty: '3' }] })).toMatch(/Choose which place/);
    expect(lineProblem({ ...l, other: [{ ...newOther(), locationId: 'W', qty: '3' }, { ...newOther(), locationId: 'W', qty: '2' }] })).toMatch(/listed twice/);
    expect(readyToQuote(draft())).toBe(true);
    expect(readyToQuote(draft({ lines: [] }))).toBe(false);
  });

  it('what stops the Sell button: credit needs a customer who may have it', () => {
    expect(saleProblems(draft({ locationId: '' }), null, false)).toEqual(['Choose where you are selling']);
    const paid = draft({ payments: [newPay('acc', '30.00')] });
    expect(saleProblems(paid, '30.00', false)).toEqual([]);
    expect(saleProblems(paid, '25.00', false)).toEqual(['The payment is more than the total']);
    expect(saleProblems(draft(), '30.00', false)).toEqual(['Choose a customer to sell on credit, or take the full payment now']);
    expect(saleProblems(draft({ customerId: 'c1' }), '30.00', false)).toEqual(['This customer cannot buy on credit: take the full payment now']);
    expect(saleProblems(draft({ customerId: 'c1' }), '30.00', true)).toEqual([]);
    expect(saleProblems(draft({ payments: [newPay('', '5')] }), '30.00', true)).toEqual(['Choose where each payment goes']);
  });
});