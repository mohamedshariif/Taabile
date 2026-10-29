// Rules for the "add a money account" form (the server checks them again).
export function moneyAccountProblems(name: string, type: 'CASH' | 'BANK', locationId: string): string[] {
  const out: string[] = [];
  if (name.trim().length < 2) out.push('Give it a name (at least 2 characters)');
  if (type === 'CASH' && !locationId) out.push('Choose which place this drawer belongs to');
  return out;
}

export const moneyAccountBody = (name: string, type: 'CASH' | 'BANK', locationId: string) => ({
  name: name.trim(),
  type,
  ...(type === 'CASH' ? { locationId } : {}),
});