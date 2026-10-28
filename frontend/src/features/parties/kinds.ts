import type { PartyKind } from '../../lib/parties';

// Customers and suppliers share the same three screens (list, new, detail). This table holds the only differences:
// the words, the web address, and which permissions the server checks.
export const KINDS: Record<PartyKind, { path: string; plural: string; one: string; view: string; manage: string; blurb: string }> = {
  customer: {
    path: 'customers',
    plural: 'Customers',
    one: 'customer',
    view: 'customers.view',
    manage: 'customers.manage',
    blurb: 'People and shops you sell to. Walk-in retail sales need no customer.',
  },
  supplier: {
    path: 'suppliers',
    plural: 'Suppliers',
    one: 'supplier',
    view: 'suppliers.view',
    manage: 'suppliers.manage',
    blurb: 'Who you buy from.',
  },
};