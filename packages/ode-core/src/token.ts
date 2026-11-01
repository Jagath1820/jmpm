import { OdeTokenPayload, OdePrincipal } from './types.js';

/**
 * Universal Base64URL decoder (Node.js and Browser safe).
 */
export function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  if (typeof atob === 'function') {
    return atob(base64);
  }
  const g = globalThis as unknown as {
    Buffer?: { from(data: string, encoding: string): { toString(enc: string): string } };
  };
  if (g.Buffer) {
    return g.Buffer.from(base64, 'base64').toString('utf8');
  }
  throw new Error('No base64 decoder available in runtime');
}

/**
 * Universal Base64URL encoder (Node.js and Browser safe).
 */
export function base64UrlEncode(input: string): string {
  let base64: string;
  if (typeof btoa === 'function') {
    base64 = btoa(input);
  } else {
    const g = globalThis as unknown as {
      Buffer?: { from(data: string, encoding: string): { toString(enc: string): string } };
    };
    if (g.Buffer) {
      base64 = g.Buffer.from(input, 'utf8').toString('base64');
    } else {
      throw new Error('No base64 encoder available in runtime');
    }
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Safely parse a raw ODE token string (JSON or base64url encoded JSON) into OdeTokenPayload.
 */
export function parseOdeToken(rawToken: string): OdeTokenPayload | null {
  try {
    const trimmed = rawToken.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('{')) {
      return JSON.parse(trimmed) as OdeTokenPayload;
    }
    const decoded = base64UrlDecode(trimmed);
    return JSON.parse(decoded) as OdeTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Extract a generic, application-agnostic principal from an ODE token root.
 */
export function odeTokenToPrincipal(token: OdeTokenPayload): OdePrincipal | null {
  const root = token.root;
  if (!root) return null;

  const userInfo = root.userInfo || {};
  return {
    id: root.sub || (userInfo.sid as string) || '',
    name: userInfo.name || root.sub || 'ODE Principal',
    role: userInfo.role,
    permissions: Array.isArray(userInfo.permissions) ? userInfo.permissions : [],
    metadata: { ...root }
  };
}
