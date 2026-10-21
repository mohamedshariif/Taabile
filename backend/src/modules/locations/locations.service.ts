import type { Tx } from '../../db/client.js';
import { withTenant } from '../../db/client.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import type { CreateLocationInput, UpdateLocationInput } from './locations.schemas.js';

type LocationRow = Awaited<ReturnType<Tx['location']['findUniqueOrThrow']>>;

const present = (l: LocationRow) => ({
  id: l.id,
  name: l.name,
  code: l.code,
  type: l.type,
  status: l.status,
  createdAt: l.createdAt,
});

/** Also used by invitations and users: checks every id is a location of this company. */
export async function assertLocationsExist(tx: Tx, companyId: string, ids: string[]) {
  if (ids.length === 0) return;
  const found = await tx.location.count({ 
    where: { companyId, id: { in: ids } } 
  });
  if (found !== ids.length) 
    throw badRequest('One or more of the chosen locations do not exist');
}

export async function listLocations(auth: AuthContext) {
  const rows = await withTenant(auth, (tx) =>
    tx.location.findMany({ where: { companyId: auth.companyId }, orderBy: [{ type: 'asc' }, { name: 'asc' }] }),
  );
  return { locations: rows.map(present) };
}

export async function createLocation(
  auth: AuthContext, 
  input: CreateLocationInput
) {
  return withTenant(auth, async (tx) => {
    const taken = await tx.location.findUnique({
      where: { companyId_code: { companyId: auth.companyId, code: input.code } },
      select: { id: true },
    });
    if (taken) throw conflict(`A location with the code ${input.code} already exists`);

    const location = await tx.location.create({
      data: { companyId: auth.companyId, name: input.name, code: input.code, type: input.type },
    });
    await writeAudit(tx, {
      companyId: auth.companyId,
      userId: auth.userId,
      action: 'location.created',
      entityType: 'location',
      entityId: location.id,
      after: { name: location.name, code: location.code, type: location.type },
    });
    return { location: present(location) };
  });
}

export async function updateLocation(
  auth: AuthContext, 
  id: string, 
  input: UpdateLocationInput
) {
  return withTenant(auth, async (tx) => {
    const before = await tx.location.findFirst({ 
      where: { id, companyId: auth.companyId } 
    });
    if (!before) throw notFound('Location not found');

    // A place that still holds goods (or goods promised to customers) cannot be closed.
    if (input.status === 'INACTIVE' && before.status === 'ACTIVE') {
      const holding = await tx.stockBalance.count({
        where: { companyId: auth.companyId, locationId: id, OR: [{ onHand: { gt: 0 } }, { committed: { gt: 0 } }] },
      });
      if (holding > 0) 
        throw conflict('This location still has stock. Move or sell it before deactivating the location.');
    }

    const after = await tx.location.update({
      where: { id },
      data: { name: input.name ?? before.name, status: input.status ?? before.status },
    });
    await writeAudit(tx, {
      companyId: auth.companyId,
      userId: auth.userId,
      action: 'location.updated',
      entityType: 'location',
      entityId: id,
      before: { name: before.name, status: before.status },
      after: { name: after.name, status: after.status },
    });
    return { location: present(after) };
  });
}