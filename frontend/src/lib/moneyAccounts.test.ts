import { describe, expect, it } from 'vitest';
import { moneyAccountBody, moneyAccountProblems } from './moneyAccounts';

describe('money account form', () => {
  it('a drawer needs a name and a place; a bank needs only a name', () => {
    expect(moneyAccountProblems('', 'CASH', '')).toHaveLength(2);
    expect(moneyAccountProblems('Till', 'CASH', '')).toEqual(['Choose which place this drawer belongs to']);
    expect(moneyAccountProblems('Till', 'CASH', 'l1')).toEqual([]);
    expect(moneyAccountProblems('Bank', 'BANK', '')).toEqual([]);
  });
  it('a bank request never carries a place', () => {
    expect(moneyAccountBody(' Main bank ', 'BANK', 'l1')).toEqual({ name: 'Main bank', type: 'BANK' });
    expect(moneyAccountBody('Till', 'CASH', 'l1')).toEqual({ name: 'Till', type: 'CASH', locationId: 'l1' });
  });
});