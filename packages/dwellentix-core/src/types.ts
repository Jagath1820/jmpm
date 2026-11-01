export type UserRole = 'admin' | 'landlord' | 'tenant';

export interface UserSummary {
  id: string;
  name: string;
  role: UserRole;
  permissions: string[];
  mustChangePassword?: boolean;
  profileComplete?: boolean;
}

export interface JwtPayload {
  id: string;
  name: string;
  role: UserRole;
  permissions: string[];
  mustChangePassword?: boolean;
  profileComplete?: boolean;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
  jti?: string;
  [key: string]: unknown;
}

import type { OdeTokenPayload } from '@ode/core';

export type {
  OdeCapability,
  OdeTokenPayload,
  OdePrincipal,
  OdeEvaluationResult
} from '@ode/core';

export interface SessionState {
  accessToken: string;
  sessionId?: string;
  expiresAt: number | string;
  user: UserSummary | null;
}

export interface TokenValidationResult {
  valid: boolean;
  expired: boolean;
  payload?: JwtPayload | OdeTokenPayload;
  error?: string;
}

