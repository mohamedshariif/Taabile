import { z } from 'zod';
import { D } from '../../shared/money.js';
import { pageQuerySchema } from '../../shared/pagination.js';
import { moneyString } from '../../shared/schemas.js';
import { isWhole } from './units.js';

const uuid = z.string().uuid();

export const nameSchema = z.string().trim().min(2, 'Enter a name').max(120);

// Uppercase letters, digits and . _ - only; the server upper-cases what you type.
export const skuSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9._-]{0,29}$/, 'Use up to 30 letters, numbers, . _ or -');

// A scanner reads letters/digits. Anything else (spaces, symbols) is almost certainly a typing mistake.
export const barcodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{4,32}$/, 'A barcode has 4 to 32 letters or numbers');

export const unitNameSchema = z.string().trim().min(1, 'Enter a unit name').max(40);

/** How many base units one package holds, for example 50 for a sack of 50 kg. Up to 6 decimals. */
export const factorSchema = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .superRefine((v, ctx) => {
    // Check the shape first: D('abc') would throw, so we must stop before doing any maths on bad text.
    if (!/^\d{1,7}(\.\d{1,6})?$/.test(v)) {
      ctx.addIssue({ code: 'custom', message: 'Enter a number with up to 6 decimals' });
      return;
    }
    const n = D(v);
    if (n.lte(0) || n.gt(1_000_000)) {
      ctx.addIssue({ code: 'custom', message: 'The conversion must be more than 0 and at most 1,000,000' });
    }
  });

const unitFlags = {
  isPurchaseUnit: z.boolean().default(false),
  isSaleUnit: z.boolean().default(true),
};

const newUnit = z.object({
  name: unitNameSchema,
  factor: factorSchema,
  barcode: barcodeSchema.nullish(),
  ...unitFlags,
});

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export const createProductSchema = z
  .object({
    name: nameSchema,
    sku: skuSchema.optional(), // left empty: the server makes one (P-000001...)
    categoryId: uuid.nullish(),
    allowFractions: z.boolean().default(false),
    baseUnit: z.object({ name: unitNameSchema, barcode: barcodeSchema.nullish() }),
    units: z.array(newUnit).max(20).default([]),
  })
  .superRefine((p, ctx) => {
    const names = [p.baseUnit.name, ...p.units.map((u) => u.name)];
    names.forEach((n, i) => {
      if (names.findIndex((m) => sameName(m, n)) !== i) {
        ctx.addIssue({ code: 'custom', message: `The unit name "${n}" is used twice`, path: ['units'] });
      }
    });
    const codes = [p.baseUnit.barcode, ...p.units.map((u) => u.barcode)].filter((b): b is string => !!b);
    if (new Set(codes).size !== codes.length) {
      ctx.addIssue({ code: 'custom', message: 'The same barcode is used on two units', path: ['units'] });
    }
    if (!p.allowFractions) {
      p.units.forEach((u, i) => {
        if (!isWhole(u.factor)) {
          ctx.addIssue({
            code: 'custom',
            message: 'This product is counted in whole pieces, so a package must hold a whole number of them',
            path: ['units', i, 'factor'],
          });
        }
      });
    }
  });

export const updateProductSchema = z
  .object({
    name: nameSchema.optional(),
    sku: skuSchema.optional(),
    categoryId: uuid.nullable().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    // Renames the base unit (only while the product has no stock history).
    baseUnitName: unitNameSchema.optional(),
    allowFractions: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Send at least one field to change' });

export const addUnitSchema = newUnit;

export const updateUnitSchema = z
  .object({
    name: unitNameSchema.optional(),
    factor: factorSchema.optional(),
    barcode: barcodeSchema.nullable().optional(), // null removes the barcode
    isPurchaseUnit: z.boolean().optional(),
    isSaleUnit: z.boolean().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Send at least one field to change' });

export const setPricesSchema = z.object({
  prices: z
    .array(
      z.object({
        priceListId: uuid,
        unitId: uuid,
        price: moneyString.nullable(), // null removes the price (the unit is then not sold on that list)
      }),
    )
    .min(1)
    .max(100),
});

export const productListQuery = pageQuerySchema.extend({
  search: z.string().trim().max(80).optional(),
  categoryId: uuid.optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE'),
});

export const categoryNameSchema = z.object({ name: z.string().trim().min(2, 'Enter a name').max(60) });

export const barcodeParam = barcodeSchema;

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type AddUnitInput = z.infer<typeof addUnitSchema>;
export type UpdateUnitInput = z.infer<typeof updateUnitSchema>;
export type SetPricesInput = z.infer<typeof setPricesSchema>;
export type ProductListQuery = z.infer<typeof productListQuery>;