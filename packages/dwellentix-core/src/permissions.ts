import { UserRole, UserSummary } from './types.js';

/**
 * Checks whether a user or role matches one or more allowed roles.
 */
export function hasRole(
  userOrRole: UserSummary | UserRole | string | null | undefined,
  allowedRoles: UserRole | UserRole[]
): boolean {
  if (!userOrRole) return false;
  const currentRole = typeof userOrRole === 'string' ? userOrRole : userOrRole.role;
  const allowed = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  return allowed.includes(currentRole as UserRole);
}

/**
 * Checks whether a user has a specific permission string.
 */
export function hasPermission(
  userOrPermissions: UserSummary | string[] | null | undefined,
  requiredPermission: string
): boolean {
  if (!userOrPermissions) return false;
  const perms = Array.isArray(userOrPermissions)
    ? userOrPermissions
    : (userOrPermissions.permissions || []);

  if (perms.includes('*') || perms.includes('all')) {
    return true;
  }
  return perms.includes(requiredPermission);
}

/**
 * Checks whether a user has at least one of the specified permissions.
 */
export function hasAnyPermission(
  userOrPermissions: UserSummary | string[] | null | undefined,
  permissions: string[]
): boolean {
  if (!userOrPermissions) return false;
  return permissions.some((p) => hasPermission(userOrPermissions, p));
}

/**
 * Checks whether a user has all of the specified permissions.
 */
export function hasAllPermissions(
  userOrPermissions: UserSummary | string[] | null | undefined,
  permissions: string[]
): boolean {
  if (!userOrPermissions) return false;
  return permissions.every((p) => hasPermission(userOrPermissions, p));
}

