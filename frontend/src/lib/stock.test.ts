import { describe, expect, it } from 'vitest';
import type { ProductSummary } from '../api/types';
/* import { canReverse, checkAmount, checkPrice, checkQuantity, lineValue, money, previewReceipt, stockLine } from './stock'; */
import { canReverse, checkAmount, checkPrice, checkQuantity, checkQuantityOrZero, countProblems, lineValue, money, newLine, previewReceipt, receiveBody, receiveProblems, stockLine, transferProblems, type DraftLine } from './stock';

const unit = (id: string, name: string, factor: string, isBase = false) => ({ id, name, factor, isBase, isPurchaseUnit: true, isSaleUnit: true, barcode: null, status: 'ACTIVE' as const });
const sugar: ProductSummary = { id: 'p1', sku: 'P-1', name: 'Sugar', status: 'ACTIVE', category: null, baseUnit: 'kg', allowFractions: true, units: [unit('u1', 'kg', '1', true), unit('u2', 'Sack 50 kg', '50')] };
const oil: ProductSummary = { ...sugar, id: 'p2', name: 'Oil', baseUnit: 'bottle', allowFractions: false, units: [unit('b', 'bottle', '1', true), unit('c', 'Carton', '12')] };

describe('quantity and price checks', () => {
  it('accepts normal quantities and refuses zero, text and too many decimals', () => {
    expect(checkQuantity('2.5', sugar, '')).toBeUndefined();
    expect(checkQuantity('0', sugar, '')).toBeDefined();
    expect(checkQuantity('abc', sugar, '')).toBeDefined();
    expect(checkQuantity('1.23456', sugar, '')).toBeDefined();
  });
  it('whole-piece products refuse half bottles, but half a carton of 12 is fine', () => {
    expect(checkQuantity('2.5', oil, '')).toMatch(/whole/);
    expect(checkQuantity('2.5', oil, 'c')).toBeUndefined(); // 30 bottles
    expect(checkQuantity('0.1', oil, 'c')).toMatch(/whole/); // 1.2 bottles
  });
  it('prices may be 0, amounts may not', () => {
    expect(checkPrice('0')).toBeUndefined();
    expect(checkPrice('12.34567')).toBeDefined();
    expect(checkAmount('0')).toBeDefined();
    expect(checkAmount('100')).toBeUndefined();
  });
});

describe('receipt preview', () => {
  it('shares landed costs by value, like the server', () => {
    expect(lineValue('10', '120')).toBe(1200);
    const p = previewReceipt([{ qtyBase: 500, value: 1200 }, { qtyBase: 200, value: 800 }], 200);
    expect(p).toMatchObject({ goods: 2000, costs: 200, total: 2200, shares: [120, 80], unitCosts: [2.64, 4.4] });
  });
  it('falls back to quantity when everything is free, and copes with nothing yet', () => {
    expect(previewReceipt([{ qtyBase: 10, value: 0 }, { qtyBase: 30, value: 0 }], 40).shares).toEqual([10, 30]);
    expect(previewReceipt([], 0).total).toBe(0);
  });
});

describe('display helpers', () => {
  it('shows packages next to the base quantity', () => {
    expect(stockLine('100.0000', 'kg', [{ name: 'Sack 50 kg', quantity: '2' }])).toBe('100 kg (2 × Sack 50 kg)');
    expect(stockLine('7', 'bottle', [])).toBe('7 bottle');
  });
  it('formats money and hides what the server hid', () => {
    expect(money('1320.0000')).toBe('1,320.00');
    expect(money('2.866667')).toBe('2.866667');
    expect(money(null)).toBe('—');
  });
  it('only manual, not-yet-reversed entries can be undone', () => {
    expect(canReverse({ type: 'ADJUSTMENT', refType: 'MANUAL', reversed: false })).toBe(true);
    expect(canReverse({ type: 'ADJUSTMENT', refType: 'MANUAL', reversed: true })).toBe(false);
    expect(canReverse({ type: 'RECEIPT', refType: 'PURCHASE', reversed: false })).toBe(false);
    expect(canReverse({ type: 'REVERSAL', refType: 'REVERSAL', reversed: false })).toBe(false);
  });
});

describe('transfers and counts forms', () => {
  const line = (qty: string): DraftLine => ({ ...newLine(sugar), unitId: 'u1', qty });
  it('a transfer needs two different places and good lines', () => {
    expect(transferProblems('', '', [])).toHaveLength(3);
    expect(transferProblems('a', 'a', [line('5')])).toEqual(['Choose two different places']);
    expect(transferProblems('a', 'b', [line('5')])).toEqual([]);
    expect(transferProblems('a', 'b', [line('0')])).toHaveLength(1); // a request for nothing
  });
  it('a count accepts 0 (an empty shelf) but not nonsense', () => {
    expect(countProblems('a', [line('0')])).toEqual([]);
    expect(countProblems('a', [line('abc')])).toHaveLength(1);
    expect(countProblems('', [line('3')])).toEqual(['Choose where you counted']);
    expect(checkQuantityOrZero('0', oil, '')).toBeUndefined();
    expect(checkQuantityOrZero('1.5', oil, '')).toMatch(/whole/);
  });
  it('receiving: only differences are sent, and a short line needs a note', () => {
    const sent = [{ productId: 'p1', qtyDispatched: '40' }, { productId: 'p2', qtyDispatched: '10' }];
    expect(receiveBody(sent, {})).toEqual({});
    expect(receiveBody(sent, { p1: { qty: '40', note: '' } })).toEqual({});
    expect(receiveBody(sent, { p1: { qty: '35', note: ' torn bag ' } })).toEqual({ lines: [{ productId: 'p1', quantity: '35', note: 'torn bag' }] });
    expect(receiveProblems(sent, { p1: { qty: '35', note: '' } })).toEqual(['Say what happened to the missing goods']);
    expect(receiveProblems(sent, { p1: { qty: '35', note: 'torn bag' } })).toEqual([]);
    expect(receiveProblems(sent, { p2: { qty: '11', note: '' } })).toEqual(['You cannot receive more than was sent']);
  });
});