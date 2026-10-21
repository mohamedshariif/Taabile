import { describe, expect, it } from 'vitest';
import { D, allocateByWeight, roundMoney, weightedAverageCost } from '../src/shared/money.js';

describe('money', () => {
  it('rounds line amounts to cents, half up', () => {
    expect(roundMoney('10.005').toString()).toBe('10.01');
    expect(roundMoney('10.004').toString()).toBe('10');
  });

  it('has no floating point drift', () => {
    expect(D('0.1').plus('0.2').toString()).toBe('0.3');
  });

  it('allocates freight by value and the parts always add up to the total', () => {
    const parts = allocateByWeight('100', ['1', '1', '1']);
    expect(parts.map(String)).toEqual(['33.3334', '33.3333', '33.3333']);
    expect(parts.reduce((a, b) => a.plus(b), D(0)).toString()).toBe('100');
  });

  it('allocates proportionally to item value', () => {
    const parts = allocateByWeight('300', ['1000', '500']);
    expect(parts.map(String)).toEqual(['200', '100']);
  });

  it('refuses to allocate across zero weight', () => {
    expect(() => allocateByWeight('10', ['0', '0'])).toThrow();
  });

  it('computes weighted average cost on receipt', () => {
    // 100 on hand at 2.00, receive 100 at 3.00 -> 2.50
    expect(weightedAverageCost('100', '2', '100', '3').toString()).toBe('2.5');
    // empty shelf: new cost is the incoming cost
    expect(weightedAverageCost('0', '9', '50', '4').toString()).toBe('4');
  });
});
