/**
 * Represents a discrete resource and action set authorized by an ODE delegation token.
 */
export interface OdeCapability {
  resource: string;
  actions: string[];
}

/**
 * Root identity and capability claims within an ODE delegation token.
 */
export interface OdeRootClaims {
  sub: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  popPublicKey?: string;
  capabilities?: OdeCapability[];
  userInfo?: {
    name?: string;
    role?: string;
    permissions?: string[];
    sid?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Multi-algorithm signature dictionary supporting Ed25519, ECDSA P-256, etc.
 */
export interface OdeSignatures {
  ed25519?: string;
  p256?: string;
  [algorithm: string]: string | undefined;
}

/**
 * Attenuation block representing caveat restrictions applied along the delegation chain.
 */
export interface OdeAttenuation {
  caveats: string[];
  prevHash: string;
  blockHash: string;
  signature?: string;
  timestamp?: number;
  [key: string]: unknown;
}

/**
 * Full ODE Delegation Token wire format.
 */
export interface OdeTokenPayload {
  suite: string;
  root: OdeRootClaims;
  signatures: OdeSignatures;
  attenuations: OdeAttenuation[];
  [key: string]: unknown;
}

/**
 * Generic principal extracted from an ODE token root.
 */
export interface OdePrincipal {
  id: string;
  name: string;
  role?: string;
  permissions: string[];
  metadata: Record<string, unknown>;
}

/**
 * Result of evaluating an ODE token against required capabilities.
 */
export interface OdeEvaluationResult {
  authorized: boolean;
  reason?: string;
  missingCapability?: {
    resource: string;
    action: string;
  };
}

