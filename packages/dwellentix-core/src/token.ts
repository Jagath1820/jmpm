import { JwtPayload, OdeTokenPayload, UserSummary, UserRole } from './types.js';
import { BEARER_PREFIX, ODE_PREFIX, DEFAULT_TOKEN_BUFFER_SECONDS } from './constants.js';

/**
 * Universal base64url decoder (Node.js and Browser safe)
 */
export function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  if (typeof atob === 'function') {
    return atob(base64);
  }
  const g = globalThis as unknown as { Buffer?: { from(data: string, encoding: string): { toString(enc: string): string } } };
  if (g.Buffer) {
    return g.Buffer.from(base64, 'base64').toString('utf8');
  }
  throw new Error('No base64 decoder available in runtime');
}

/**
 * Parse and decode JWT payload without cryptographic verification.
 * Works uniformly in browser (UI) and server (API/ODE).
 */
export function parseJwt<T = JwtPayload>(token: string): T | null {
  try {
    const parts = token.trim().split('.');
    if (parts.length !== 3) {
      return null;
    }
    const payloadJson = base64UrlDecode(parts[1]);
    return JSON.parse(payloadJson) as T;
  } catch {
    return null;
  }
}

/**
 * Extract bearer or ODE token from an Authorization header or Express request object.
 */
export function extractAuthToken(
  input: string | { headers?: Record<string, string | string[] | undefined> } | null | undefined
): { token: string; type: 'Bearer' | 'ODE' } | null {
  if (!input) return null;

  let authHeader = '';
  if (typeof input === 'string') {
    authHeader = input;
  } else if (input.headers) {
    const raw = input.headers['authorization'] || input.headers['Authorization'];
    authHeader = Array.isArray(raw) ? raw[0] : (raw || '');
  }

  const trimmed = authHeader.trim();
  if (trimmed.startsWith(BEARER_PREFIX)) {
    return { token: trimmed.slice(BEARER_PREFIX.length).trim(), type: 'Bearer' };
  }
  if (trimmed.startsWith(ODE_PREFIX)) {
    return { token: trimmed.slice(ODE_PREFIX.length).trim(), type: 'ODE' };
  }

  return null;
}

/**
 * Extract plain bearer token string.
 */
export function extractBearerToken(
  input: string | { headers?: Record<string, string | string[] | undefined> } | null | undefined
): string | null {
  const result = extractAuthToken(input);
  return result?.type === 'Bearer' ? result.token : null;
}

/**
 * Get the expiration timestamp (in milliseconds) from a token string or parsed payload.
 */
export function getTokenExpMs(tokenOrPayload: string | JwtPayload | OdeTokenPayload): number | null {
  let expSeconds: number | undefined;

  if (typeof tokenOrPayload === 'string') {
    const parsed = parseJwt(tokenOrPayload);
    expSeconds = parsed?.exp;
  } else {
    const anyPayload = tokenOrPayload as Record<string, any>;
    if (anyPayload.root && typeof anyPayload.root.exp === 'number') {
      expSeconds = anyPayload.root.exp;
    } else if (typeof anyPayload.exp === 'number') {
      expSeconds = anyPayload.exp;
    }
  }

  return typeof expSeconds === 'number' ? expSeconds * 1000 : null;
}

/**
 * Check if a token or payload has expired, with an optional safety buffer in seconds.
 */
export function isTokenExpired(
  tokenOrPayload: string | JwtPayload | OdeTokenPayload,
  bufferSeconds: number = DEFAULT_TOKEN_BUFFER_SECONDS
): boolean {
  const expMs = getTokenExpMs(tokenOrPayload);
  if (!expMs) return true;
  return Date.now() + bufferSeconds * 1000 >= expMs;
}

/**
 * Get remaining validity time in milliseconds.
 */
export function getTokenRemainingTimeMs(tokenOrPayload: string | JwtPayload | OdeTokenPayload): number {
  const expMs = getTokenExpMs(tokenOrPayload);
  if (!expMs) return 0;
  const remaining = expMs - Date.now();
  return remaining > 0 ? remaining : 0;
}

/**
 * Convert JwtPayload claims to standard UserSummary.
 */
export function claimsToUserSummary(claims: JwtPayload): UserSummary {
  return {
    id: claims.id || (claims.sub as string) || '',
    name: claims.name || '',
    role: (claims.role as UserRole) || 'tenant',
    permissions: Array.isArray(claims.permissions) ? claims.permissions : [],
    mustChangePassword: Boolean(claims.mustChangePassword),
    profileComplete: Boolean(claims.profileComplete)
  };
}
