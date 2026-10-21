// Builds Postgres DDL from prisma/schema.prisma so the database rules in prisma/constraints.sql
// can be tested on an in-memory Postgres (PGlite) with no Docker. This approximates what
// `prisma migrate` creates (tables, types, defaults, keys, foreign keys). The real migrated
// database remains the final check.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wasm = require('@prisma/prisma-schema-wasm') as { get_dmmf: (p: string) => string };

interface Field {
  name: string;
  kind: 'scalar' | 'enum' | 'object';
  type: string;
  isList: boolean;
  isRequired: boolean;
  isId: boolean;
  isUnique: boolean;
  hasDefaultValue: boolean;
  default?: unknown;
  nativeType?: [string, string[]] | null;
  relationFromFields?: string[];
  relationToFields?: string[];
}
interface Model {
  name: string;
  dbName: string | null;
  fields: Field[];
  primaryKey: { fields: string[] } | null;
  uniqueIndexes: { fields: string[] }[];
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

function sqlType(f: Field): string {
  if (f.kind === 'enum') return q(f.type) + (f.isList ? '[]' : '');
  const [n, args] = f.nativeType ?? [null, []];
  let t: string;
  switch (n) {
    case 'Uuid': t = 'uuid'; break;
    case 'Decimal': t = `numeric(${(args ?? []).join(',')})`; break;
    case 'Timestamptz': t = `timestamptz(${(args ?? ['3'])[0]})`; break;
    case 'Date': t = 'date'; break;
    case 'Char': t = `char(${(args ?? ['3'])[0]})`; break;
    default:
      t = { String: 'text', Int: 'integer', Boolean: 'boolean', Json: 'jsonb', DateTime: 'timestamp(3)', Decimal: 'numeric(65,30)', BigInt: 'bigint' }[f.type] ?? 'text';
  }
  return f.isList ? `${t}[]` : t;
}

function sqlDefault(f: Field): string {
  const d = f.default as unknown;
  if (d === undefined || d === null) return '';
  if (typeof d === 'object' && !Array.isArray(d)) {
    const name = (d as { name: string }).name;
    if (name === 'uuid') return ' DEFAULT gen_random_uuid()';
    if (name === 'now') return ' DEFAULT now()';
    return '';
  }
  if (Array.isArray(d)) return d.length === 0 ? " DEFAULT '{}'" : '';
  if (typeof d === 'string') return ` DEFAULT '${d.replace(/'/g, "''")}'`;
  return ` DEFAULT ${String(d)}`;
}

export function buildDdl(schemaPath = 'prisma/schema.prisma'): string {
  const schema = readFileSync(schemaPath, 'utf8');
  const dmmf = JSON.parse(wasm.get_dmmf(JSON.stringify({ prismaSchema: [['schema.prisma', schema]], noColor: true })));
  const models: Model[] = dmmf.datamodel.models;
  const enums: { name: string; values: { name: string }[] }[] = dmmf.datamodel.enums;
  const table = (name: string) => q(models.find((m) => m.name === name)!.dbName ?? name);

  const out: string[] = [];
  for (const e of enums) out.push(`CREATE TYPE ${q(e.name)} AS ENUM (${e.values.map((v) => `'${v.name}'`).join(', ')});`);

  const fks: string[] = [];
  for (const m of models) {
    const cols: string[] = [];
    for (const f of m.fields) {
      if (f.kind === 'object') {
        if (f.relationFromFields?.length) {
          fks.push(
            `ALTER TABLE ${table(m.name)} ADD FOREIGN KEY (${f.relationFromFields.map(q).join(', ')}) REFERENCES ${table(f.type)} (${f.relationToFields!.map(q).join(', ')});`,
          );
        }
        continue;
      }
      let col = `${q(f.name)} ${sqlType(f)}`;
      if (f.isRequired) col += ' NOT NULL';
      col += sqlDefault(f);
      if (f.isId) col += ' PRIMARY KEY';
      if (f.isUnique) col += ' UNIQUE';
      cols.push(col);
    }
    if (m.primaryKey) cols.push(`PRIMARY KEY (${m.primaryKey.fields.map(q).join(', ')})`);
    for (const u of m.uniqueIndexes) {
      if (u.fields.length > 1 || !m.fields.find((f) => f.name === u.fields[0])?.isUnique) {
        cols.push(`UNIQUE (${u.fields.map(q).join(', ')})`);
      }
    }
    out.push(`CREATE TABLE ${table(m.name)} (\n  ${cols.join(',\n  ')}\n);`);
  }
  return [...out, ...fks].join('\n');
}
