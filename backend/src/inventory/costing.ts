import { Decimal } from 'decimal.js';
import type { Tx } from '../db/client.js';
import { D, storeCost, weightedAverageCost, ZERO, type Numeric } from '../shared/money.js';

// How stock is valued. Today there is ONE method (weighted average cost per location), but everything that
// moves stock talks to this small interface and never does cost maths itself. To add FIFO later you write a
// second class that implements `CostingMethod` and make `costingFor` choose it (for example from a company
// setting). Nothing else in the system has to change.

/** What the costing method needs to know about one product at one location right now. */
export interface CostState {
  onHand: Decimal;
  avgCost: Decimal; // cost per BASE unit
}

/** Which product, where. A method that keeps its own data (FIFO layers) uses `tx` to read and write it. */
export interface CostScope {
  tx: Tx;
  companyId: string;
  locationId: string;
  productId: string;
}

export interface Issued {
  /** Cost per base unit of the goods that left. */
  unitCost: Decimal;
  state: CostState;
}

export interface CostingMethod {
  readonly name: string;
  /** Goods arrive: `qty` base units that cost `unitCost` each. Returns the new state. */
  receive(scope: CostScope, state: CostState, qty: Numeric, unitCost: Numeric): Promise<CostState>;
  /** Goods leave: `qty` base units. Says what they cost and the new state. */
  issue(scope: CostScope, state: CostState, qty: Numeric): Promise<Issued>;
    /**
   * Takes back the most recent movement exactly (used when a mistake is reversed).
   * `qty` is signed like the movement: positive = it was an arrival, negative = it was an issue.
   * `before` is the average cost per base unit that was recorded just before that movement (null for old rows).
   */
  undo(scope: CostScope, state: CostState, qty: Numeric, unitCost: Numeric, before?: Numeric | null): Promise<CostState>;
}

/**
 * Weighted average cost per location: every arrival blends into one average cost per base unit; goods that
 * leave are valued at the average at that moment, and leaving never changes the average.
 *   100 kg at 2.00 + 50 kg at 3.50  ->  150 kg at 2.50
 */
export const weightedAverage: CostingMethod = {
  name: 'WEIGHTED_AVERAGE',

  async receive(_scope, state, qty, unitCost) {
    return {
      onHand: state.onHand.plus(qty),
      avgCost: weightedAverageCost(state.onHand, state.avgCost, qty, unitCost),
    };
  },

  async issue(_scope, state, qty) {
    return {
      unitCost: state.avgCost,
      // Even when the shelf becomes empty the last average is kept; the next arrival replaces it (zero on hand has no weight).
      state: { onHand: state.onHand.minus(qty), avgCost: state.avgCost },
    };
  },

  async undo(_scope, state, qty, unitCost, before) {
    const q = D(qty);
    // The exact average that was there before is recorded on the movement, so undoing never drifts by rounding.
    if (before !== undefined && before !== null) return { onHand: state.onHand.minus(q), avgCost: D(before) };
    if (q.lt(0)) {
      // An issue is undone by putting the goods back at the same average (the issue never changed it).
      return { onHand: state.onHand.minus(q), avgCost: state.avgCost };
    }
    // An arrival is undone by taking its goods back out of the blend: (onHand*avg - qty*cost) / (onHand - qty).
    const left = state.onHand.minus(q);
    if (left.lte(0)) return { onHand: ZERO, avgCost: state.avgCost };
    const avg: Decimal = storeCost(state.onHand.times(state.avgCost).minus(q.times(unitCost)).div(left));
    return { onHand: left, avgCost: avg.lt(0) ? ZERO : avg };
  },
};

/** The method used for a company. One method today; this is the single place that will choose between methods later. */
export function costingFor(_companyId: string): CostingMethod {
  return weightedAverage;
}