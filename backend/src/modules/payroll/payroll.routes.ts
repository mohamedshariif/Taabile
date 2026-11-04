import { Router } from 'express';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError } from '../../shared/errors.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import {
  accrueSchema,
  adjustSchema,
  createEmployeeSchema,
  employeeListQuery,
  ledgerQuery,
  linkableQuery,
  paySchema,
  periodQuery,
  salarySchema,
  updateEmployeeSchema,
  voidEntrySchema
} from './payroll.schemas.js';
import * as payroll from './payroll.service.js';

// Who may do what (pay is private, so a Manager or Staff member gets neither):
//   payroll.view    see employees, their pay and what is owed (Admin, Viewer)
//   payroll.manage  add and change employees, post salaries, pay, correct and cancel (Admin)
export const employeesRouter = Router();
export const payrollRouter = Router();
const need = (p: Parameters<typeof requirePermission>[0]) => [authenticate, requirePermission(p)];
const idOf = (req: { params: { id?: string | undefined } }) => uuidParam(req.params.id);
const parse = <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { flatten: () => { fieldErrors: unknown } } } }, v: unknown): T => {
  const r = schema.safeParse(v);
  if (!r.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', r.error!.flatten().fieldErrors);
  return r.data as T;
};

employeesRouter.get('/',
  ...need('payroll.view'),
  asyncHandler(async (req, res) => res.json(await payroll.listEmployees(getAuth(req), parse(employeeListQuery, req.query))))
);
employeesRouter.get('/linkable-users',
  ...need('payroll.manage'),
  asyncHandler(async (req, res) => res.json(await payroll.linkableUsers(getAuth(req), parse(linkableQuery, req.query).employeeId)))
);
employeesRouter.get('/:id',
  ...need('payroll.view'),
  asyncHandler(async (req, res) => res.json(await payroll.getEmployee(getAuth(req), idOf(req))))
);
employeesRouter.get('/:id/ledger',
...need('payroll.view'),
asyncHandler(async (req, res) => res.json(await payroll.employeeLedger(getAuth(req), idOf(req), parse(ledgerQuery, req.query))))
);
employeesRouter.post('/',
  ...need('payroll.manage'),
  validateBody(createEmployeeSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await payroll.createEmployee(getAuth(req), req.body, req.ip)))
);
employeesRouter.patch('/:id',
  ...need('payroll.manage'),
  validateBody(updateEmployeeSchema),
  asyncHandler(async (req, res) => res.json(await payroll.updateEmployee(getAuth(req), idOf(req), req.body, req.ip)))
);
employeesRouter.post('/:id/salary',
  ...need('payroll.manage'),
  validateBody(salarySchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await payroll.setSalary(getAuth(req), idOf(req), req.body, req.ip)))
);
payrollRouter.get('/preview',
  ...need('payroll.manage'),
  asyncHandler(async (req, res) => res.json(await payroll.preview(getAuth(req), parse(periodQuery, req.query).period)))
);
payrollRouter.post('/accrue',
  ...need('payroll.manage'),
  validateBody(accrueSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await payroll.accrue(getAuth(req), req.body.period, req.ip)))
);
payrollRouter.post('/pay',
  ...need('payroll.manage'),
  validateBody(paySchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await payroll.pay(getAuth(req), req.body, req.ip)))
);
payrollRouter.post('/adjust',
  ...need('payroll.manage'),
  validateBody(adjustSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await payroll.adjust(getAuth(req), req.body, req.ip)))
);
payrollRouter.post('/entries/:id/void',
  ...need('payroll.manage'),
  validateBody(voidEntrySchema),
  idempotent,
  asyncHandler(async (req, res) => res.json(await payroll.voidEntry(getAuth(req), idOf(req), req.body.reason, req.ip)))
);