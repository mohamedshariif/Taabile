import { describe, expect, it } from 'vitest';
import type { Customer } from '../api/types';
import { changedFields, creditText, customerBody, describeBalance, draftFrom, emptyParty, hasProblems, normalizePhone, savedAsBody, supplierBody, validateParty } from './parties';

const mary: Customer = {
  id: '1', code: 'C-000001', name: 'Mary Store', phone: '+211912345678', address: null,
  priceList: { id: 'w', name: 'Wholesale' }, creditLimit: '1500.0000', paymentTermsDays: 30, status: 'ACTIVE', balance: '0.0000', createdAt: '',
};

describe('party form', () => {
  it('cleans phone numbers like the server does', () => {
    expect(normalizePhone(' +211 912-345 (678) ')).toBe('+211912345678');
  });

  it('a good form passes; an empty one asks for a name', () => {
    expect(hasProblems(validateParty({ ...emptyParty(), name: 'Mary Store' }))).toBe(false);
    expect(validateParty(emptyParty()).name).toBeTruthy();
  });

  it('catches bad phone, code, credit and days', () => {
    const p = validateParty({ ...emptyParty(), name: 'Mary', phone: 'abc', code: 'has space', creditLimit: '-5', paymentTermsDays: '400' });
    expect([p.phone, p.code, p.creditLimit, p.paymentTermsDays].every(Boolean)).toBe(true);
    expect(validateParty({ ...emptyParty(), name: 'Mary', creditLimit: '12.34567' }).creditLimit).toBeTruthy();
    expect(validateParty({ ...emptyParty(), name: 'Mary', paymentTermsDays: '1.5' }).paymentTermsDays).toBeTruthy();
    expect(validateParty({ ...emptyParty(), name: 'Mary', creditLimit: '', phone: '' })).toEqual({});
  });

  it('builds request bodies: credit only for people who manage credit, empty boxes become null', () => {
    const d = { ...emptyParty(), name: ' Mary ', code: ' c-7 ', phone: '0912 345 678', creditLimit: '500', paymentTermsDays: '30' };
    expect(customerBody(d, false)).toEqual({ name: 'Mary', code: 'C-7', phone: '0912345678', address: null, priceListId: null });
    expect(customerBody(d, true)).toMatchObject({ creditLimit: '500', paymentTermsDays: 30 });
    expect(customerBody({ ...d, creditLimit: '' }, true).creditLimit).toBeNull();
    expect(supplierBody(d)).toEqual({ name: 'Mary', code: 'C-7', phone: '0912345678', address: null, paymentTermsDays: 30 });
  });

  it('sends only what changed', () => {
    const d = draftFrom(mary);
    expect(changedFields(customerBody(d, true), savedAsBody(mary, true))).toEqual({});
    const edited = { ...d, name: 'Mary Shop', creditLimit: '' };
    expect(changedFields(customerBody(edited, true), savedAsBody(mary, true))).toEqual({ name: 'Mary Shop', creditLimit: null });
    // Without credit permission the credit fields are not compared at all.
    expect(changedFields(customerBody({ ...d, creditLimit: '9' }, false), savedAsBody(mary, false))).toEqual({});
  });
});

describe('words for money', () => {
  it('describes balances from each side', () => {
    expect(describeBalance('customer', '250.7500', 'USD')).toBe('Owes us 250.75 USD');
    expect(describeBalance('customer', '-10.0000', 'USD')).toBe('We owe them 10.00 USD');
    expect(describeBalance('supplier', '1200.0000', 'USD')).toBe('We owe 1200.00 USD');
    expect(describeBalance('supplier', '0.0000', 'USD')).toBe('Settled');
  });
  it('describes credit', () => {
    expect(creditText(null, 0)).toBe('Cash only');
    expect(creditText('1500.0000', 30)).toBe('Up to 1500.00, pays within 30 days');
  });
});