import { UserRole } from './types.js';

export const AUTH_HEADER = 'authorization';
export const BEARER_PREFIX = 'Bearer ';
export const ODE_PREFIX = 'ODE ';
export const ACCESS_TOKEN_TYPE = 'access';

export const USER_ROLES: readonly UserRole[] = ['admin', 'landlord', 'tenant'] as const;

export const DEFAULT_TOKEN_BUFFER_SECONDS = 30;

