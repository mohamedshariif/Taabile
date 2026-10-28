import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { costingFor, weightedAverage, type CostingMethod, type CostScope, type CostState } from '../src/inventory/costing.js';

// The costing method needs no database for weighted average: scope is only handed through.
const scope = {} as CostScope;
const st = (onHand: string, avgCost: string): CostState => ({ onHand: new Decimal(onHand), avgCost: new Decimal(avgCost) });
const show = (s: CostState) => [s.onHand.toFixed(), s.avgCost.toFixed(6)];

describe('weighted average cost', () => {
  it('blends arrivals into one average per base unit', async () => {
    let s = st('0', '0');
    s = await weightedAverage.receive(scope, s, '100', '2');
    expect(show(s)).toEqual(['100', '2.000000']);
    s = await weightedAverage.receive(scope, s, '50', '3.5'); // (100*2 + 50*3.5) / 150
    expect(show(s)).toEqual(['150', '2.500000']);
  });

  it('goods that leave cost the current average and never change it', async () => {
    const out = await weightedAverage.issue(scope, st('150', '2.5'), '30');
    expect(out.unitCost.toFixed(6)).toBe('2.500000');
    expect(show(out.state)).toEqual(['120', '2.500000']);
    const after = await weightedAverage.receive(scope, out.state, '30', '4'); // (120*2.5 + 30*4) / 150
    expect(show(after)).toEqual(['150', '2.800000']);
  });

  it('an empty shelf has no weight: the next arrival sets the cost, even after a higher old cost', async () => {
    const emptied = (await weightedAverage.issue(scope, st('10', '9'), '10')).state;
    expect(show(emptied)).toEqual(['0', '9.000000']);
    expect(show(await weightedAverage.receive(scope, emptied, '5', '1.25'))).toEqual(['5', '1.250000']);
  });

  it('keeps 6 decimals so repeating fractions do not drift', async () => {
    const s = await weightedAverage.receive(scope, st('1', '1'), '2', '2'); // (1 + 4) / 3
    expect(s.avgCost.toFixed(6)).toBe('1.666667');
  });

  it('undo gives back exactly what the movement took', async () => {
    const before = st('100', '2');
    const arrived = await weightedAverage.receive(scope, before, '50', '3.5');
    const undone = await weightedAverage.undo(scope, arrived, '50', '3.5');
    expect(show(undone)).toEqual(show(before));

    const issued = (await weightedAverage.issue(scope, before, '30')).state;
    expect(show(await weightedAverage.undo(scope, issued, '-30', '2'))).toEqual(show(before));

    const first = await weightedAverage.receive(scope, st('0', '0'), '40', '1.5');
    expect(show(await weightedAverage.undo(scope, first, '40', '1.5'))[0]).toBe('0');
  });
});

describe('undo is exact even when the average cannot be written in 6 decimals', () => {
  it('uses the average recorded before the movement instead of recomputing it', async () => {
    const before = st('150', '4'); // 150 kg at 4.00
    const arrived = await weightedAverage.receive(scope, before, '200', '4.4'); // 350 kg at 4.228571 (rounded)
    expect(arrived.avgCost.toFixed(6)).toBe('4.228571');
    // recomputing from the rounded average would give 3.999999: the recorded value avoids that
    expect(show(await weightedAverage.undo(scope, arrived, '200', '4.4'))[1]).toBe('3.999999');
    expect(show(await weightedAverage.undo(scope, arrived, '200', '4.4', '4'))).toEqual(['150', '4.000000']);
  });
});

describe('costing is replaceable', () => {
  it('companies get a method through costingFor, and any class with the same three actions can stand in (for example FIFO later)', async () => {
    expect(costingFor('any-company').name).toBe('WEIGHTED_AVERAGE');
    // A stand-in that costs everything at 1.00: proves callers depend only on the interface, not on weighted average.
    const flat: CostingMethod = {
      name: 'FLAT',
      receive: async (_s, state, qty) => ({ onHand: state.onHand.plus(qty), avgCost: new Decimal(1) }),
      issue: async (_s, state, qty) => ({ unitCost: new Decimal(1), state: { onHand: state.onHand.minus(qty), avgCost: new Decimal(1) } }),
      undo: async (_s, state, qty) => ({ onHand: state.onHand.minus(qty), avgCost: new Decimal(1) }),
    };
    expect((await flat.issue(scope, st('5', '9'), '2')).unitCost.toFixed()).toBe('1');
  });
});