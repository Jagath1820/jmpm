import { parseOdeToken, hasOdeCapability, type OdeTokenPayload } from '@ode/core';
import { UserSummary, UserRole } from './types.js';

export { parseOdeToken, hasOdeCapability };

/**
 * Extract Dwellentix UserSummary from ODE token root claims.
 */
export function odeClaimsToUser(odeToken: OdeTokenPayload): UserSummary | null {
  const root = odeToken.root;
  if (!root) return null;

  const userInfo = root.userInfo || {};
  return {
    id: root.sub || (userInfo.sid as string) || '',
    name: userInfo.name || root.sub || 'ODE User',
    role: (userInfo.role as UserRole) || 'tenant',
    permissions: Array.isArray(userInfo.permissions) ? userInfo.permissions : []
  };
}
