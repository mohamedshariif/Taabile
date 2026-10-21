import { z } from 'zod';
import { PERMISSIONS, ROLES } from '../auth/permissions.js';

const permissionSchema = z.enum(PERMISSIONS);

export const updateMemberSchema = z
  .object({
    role: z.enum(ROLES).optional(),
    // Replaces the person's stores. Ignored for Admin and Viewer, who see the whole company.
    locationIds: z.array(z.string().uuid()).max(50).optional(),
    // Permissions switched ON for this person on top of their role.
    extraPermissions: z.array(permissionSchema).max(PERMISSIONS.length).optional(),
    // Permissions switched OFF for this person even though their role has them.
    revokedPermissions: z.array(permissionSchema).max(PERMISSIONS.length).optional(),
  })
  .refine(
    (v) => v.role !== undefined || v.locationIds !== undefined || v.extraPermissions !== undefined || v.revokedPermissions !== undefined,
    { message: 'Send at least one thing to change' },
  )
  .refine((v) => !(v.extraPermissions ?? []).some((p) => (v.revokedPermissions ?? []).includes(p)), {
    message: 'A permission cannot be switched on and off at the same time',
    path: ['revokedPermissions'],
  });

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;