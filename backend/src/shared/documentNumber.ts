import type { Tx } from '../db/client.js';

export async function nextDocumentNumber(
  tx: Tx,
  companyId: string,
  docType: string,
  opts: { scopeKey?: string; prefix?: string } = {},
): Promise<string> {
  const scopeKey = opts.scopeKey ?? 'company';
  const prefix = opts.prefix ?? (scopeKey === 'company' ? docType : `${docType}-${scopeKey}`);
  const rows = await tx.$queryRaw<{ n: number }[]>`
    INSERT INTO document_sequences (id, "companyId", "docType", "scopeKey", prefix, "nextNumber")
    VALUES (gen_random_uuid(), ${companyId}::uuid, ${docType}, ${scopeKey}, ${prefix}, 2)
    ON CONFLICT ("companyId", "docType", "scopeKey")
    DO UPDATE SET "nextNumber" = document_sequences."nextNumber" + 1
    RETURNING "nextNumber" - 1 AS n`;
  const n = rows[0]!.n;
  return `${prefix}-${String(n).padStart(6, '0')}`;
}