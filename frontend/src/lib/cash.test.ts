import { describe, expect, it } from 'vitest';
import type { CashChoice } from '../api/types';
import { checkAmount2, checkCounted, confirmBody, confirmProblems, expenseBody, expenseProblems, moveBody, moveProblems, needsConfirmation, transferKind } from './cash';

const drawer: CashChoice = { id: 'd1', name: 'A drawer', type: 'CASH', place: 'Store A' };
const drawer2: CashChoice = { id: 'd2', name: 'B drawer', type: 'CASH', place: 'Store B' };
const bank: CashChoice = { id: 'b1', name: 'Bank', type: 'BANK', place: null };

describe('cash helpers', () => {
  it('amounts: a cost needs more than zero, a count may be zero', () => {
    expect(checkAmount2('12.50')).toBeUndefined();
    for (const bad of ['', '0', '1.005', '-3']) expect(checkAmount2(bad)).toBeTruthy();
    expect(checkCounted('0')).toBeUndefined();
    expect(checkCounted('-1')).toBeTruthy();
  });

  it('knows the kind of movement, and which ones wait for confirmation', () => {
    expect(transferKind(drawer, bank)).toBe('DEPOSIT');
    expect(transferKind(drawer, drawer2)).toBe('HANDOVER');
    expect(transferKind(bank, drawer)).toBe('WITHDRAWAL');
    expect(transferKind(bank, bank)).toBe('TRANSFER');
    expect(transferKind(undefined, bank)).toBeNull();
    expect(needsConfirmation('DEPOSIT')).toBe(true);
    expect(needsConfirmation('WITHDRAWAL')).toBe(false);
  });

  it('an expense: what stops Save, and the request', () => {
    const d = { categoryId: 'c', amount: '40', description: 'Fuel', accountId: 'd1', locationId: '', date: '' };
    expect(expenseProblems(d, false)).toEqual([]);
    expect(expenseProblems(d, true)).toEqual(['Choose which place this cost belongs to']);
    expect(expenseProblems({ ...d, amount: '0', description: 'x', categoryId: '' }, false)).toHaveLength(3);
    expect(expenseBody({ ...d, locationId: 'A', date: '2026-10-01', description: ' Fuel ' })).toEqual({ categoryId: 'c', amount: '40', description: 'Fuel', financialAccountId: 'd1', locationId: 'A', incurredOn: '2026-10-01' });
  });

  it('a movement: two different accounts and an amount', () => {
    expect(moveProblems({ fromId: 'd1', toId: 'b1', amount: '50', note: '' })).toEqual([]);
    expect(moveProblems({ fromId: 'd1', toId: 'd1', amount: '50', note: '' })).toEqual(['Choose two different accounts']);
    expect(moveProblems({ fromId: '', toId: '', amount: '', note: '' })).toHaveLength(3);
    expect(moveBody({ fromId: 'd1', toId: 'b1', amount: ' 50 ', note: '' })).toEqual({ fromAccountId: 'd1', toAccountId: 'b1', amount: '50' });
  });

  it('confirming: a different amount needs a note', () => {
    expect(confirmProblems('50.0000', '', '')).toEqual([]);
    expect(confirmProblems('50.0000', '50', '')).toEqual([]);
    expect(confirmProblems('50.0000', '48', '')).toHaveLength(1);
    expect(confirmProblems('50.0000', '48', 'two notes torn')).toEqual([]);
    expect(confirmBody('48', ' torn ')).toEqual({ receivedAmount: '48', differenceNote: 'torn' });
    expect(confirmBody('', '')).toEqual({});
  });
});