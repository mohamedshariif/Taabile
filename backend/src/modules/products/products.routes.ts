import { Router } from 'express';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError } from '../../shared/errors.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import {
  addUnitSchema,
  barcodeParam,
  categoryNameSchema,
  createProductSchema,
  productListQuery,
  setPricesSchema,
  updateProductSchema,
  updateUnitSchema,
  updateCategorySchema,
} from './products.schemas.js';
import * as products from './products.service.js';

// Who may do what:
//   products.view    see products, categories, price lists (Admin, Manager, Staff, Viewer)
//   products.manage  create and change products, units, conversions, barcodes (Admin and Manager)
//   prices.manage    change selling prices (Admin; can be switched on for one Manager)
const view = [authenticate, requirePermission('products.view')];
const manage = [authenticate, requirePermission('products.manage')];
const pricing = [authenticate, requirePermission('prices.manage')];
const erase = [authenticate, requirePermission('records.delete')];

export const productsRouter = Router();

productsRouter.get(
  '/',
  ...view,
  asyncHandler(async (req, res) => {
    const q = productListQuery.safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', q.error.flatten().fieldErrors);
    res.json(await products.listProducts(getAuth(req), q.data));
  }),
);

// Must come before '/:id', otherwise "by-barcode" would be read as a product id.
productsRouter.get(
  '/by-barcode/:code',
  ...view,
  asyncHandler(async (req, res) => {
    const code = barcodeParam.safeParse(req.params.code);
    if (!code.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid barcode');
    res.json(await products.findByBarcode(getAuth(req), code.data));
  }),
);

productsRouter.get('/:id', ...view, asyncHandler(async (req, res) => res.json(await products.getProduct(getAuth(req), uuidParam(req.params.id)))));

// Creating routes carry an Idempotency-Key header, so a retry can never create a second product or unit.
productsRouter.post(
  '/',
  ...manage,
  validateBody(createProductSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await products.createProduct(getAuth(req), req.body, req.ip))),
);

productsRouter.patch(
  '/:id',
  ...manage,
  validateBody(updateProductSchema),
  asyncHandler(async (req, res) => res.json(await products.updateProduct(getAuth(req), uuidParam(req.params.id), req.body, req.ip))),
);

productsRouter.post(
  '/:id/units',
  ...manage,
  validateBody(addUnitSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await products.addUnit(getAuth(req), uuidParam(req.params.id), req.body, req.ip))),
);

productsRouter.patch(
  '/:id/units/:unitId',
  ...manage,
  validateBody(updateUnitSchema),
  asyncHandler(async (req, res) =>
    res.json(await products.updateUnit(getAuth(req), uuidParam(req.params.id), uuidParam(req.params.unitId, 'unit id'), req.body, req.ip))),
);

productsRouter.put(
  '/:id/prices',
  ...pricing,
  validateBody(setPricesSchema),
  asyncHandler(async (req, res) => res.json(await products.setPrices(getAuth(req), uuidParam(req.params.id), req.body, req.ip))),
);

productsRouter.delete(
  '/:id',
  ...erase,
  asyncHandler(async (req, res) => res.json(await products.deleteProduct(getAuth(req), uuidParam(req.params.id), req.ip)))
);

// ── Categories (a flat list) ──
export const categoriesRouter = Router();
categoriesRouter.get('/', ...view, asyncHandler(async (req, res) => res.json(await products.listCategories(getAuth(req)))));
categoriesRouter.post(
  '/',
  ...manage,
  validateBody(categoryNameSchema),
  asyncHandler(async (req, res) => res.status(201).json(await products.createCategory(getAuth(req), req.body.name, req.ip))),
);
categoriesRouter.patch(
  '/:id',
  ...manage,
  validateBody(updateCategorySchema),
  asyncHandler(async (req, res) => res.json(await products.updateCategory(getAuth(req), uuidParam(req.params.id), req.body, req.ip))),
);
categoriesRouter.delete('/:id', ...erase, asyncHandler(async (req, res) => res.json(await products.deleteCategory(getAuth(req), uuidParam(req.params.id), req.ip))));

// ── Price lists (Retail and Wholesale are created with the company) ──
export const priceListsRouter = Router();
priceListsRouter.get('/', ...view, asyncHandler(async (req, res) => res.json(await products.listPriceLists(getAuth(req)))));