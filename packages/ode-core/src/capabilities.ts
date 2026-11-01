import { OdeCapability, OdeTokenPayload, OdeEvaluationResult } from './types.js';

/**
 * Checks if a requested resource matches a capability resource (with wildcard support).
 */
export function matchesResource(pattern: string, resource: string): boolean {
  if (pattern === '*' || pattern === resource) return true;
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return resource === prefix || resource.startsWith(`${prefix}:`);
  }
  return false;
}

/**
 * Checks if a requested action matches any capability action (with wildcard support).
 */
export function matchesAction(actions: string[], requestedAction: string): boolean {
  return actions.some((act) => act === '*' || act === 'all' || act.toLowerCase() === requestedAction.toLowerCase());
}

/**
 * Check whether an ODE token contains a specific capability (resource + action).
 */
export function hasOdeCapability(
  odeToken: OdeTokenPayload | null | undefined,
  resource: string,
  action: string
): boolean {
  if (!odeToken?.root?.capabilities) return false;

  return odeToken.root.capabilities.some((cap) => {
    return matchesResource(cap.resource, resource) && matchesAction(cap.actions, action);
  });
}

/**
 * Evaluates whether an ODE token satisfies the required capability set.
 */
export function evaluateCapabilities(
  odeToken: OdeTokenPayload | null | undefined,
  required: Array<{ resource: string; action: string }>
): OdeEvaluationResult {
  if (!odeToken) {
    return { authorized: false, reason: 'ODE token missing or unparseable' };
  }

  for (const req of required) {
    if (!hasOdeCapability(odeToken, req.resource, req.action)) {
      return {
        authorized: false,
        reason: `Missing capability: ${req.resource}#${req.action}`,
        missingCapability: req
      };
    }
  }

  return { authorized: true };
}

