# @dwellentix/auth

Universal authentication, ODE (Open Delegation Engine) capability verification, and session contracts for Dwellentix API, UI, and ODE.

## Features

- **Universal Token Parser**: Works uniformly in Browser (UI) and Node.js (API & ODE) without heavy dependencies.
- **Role & Permission Checkers**: `hasRole`, `hasPermission`, `hasAnyPermission`.
- **ODE Capability Contracts**: Full types and validators for ODE delegation tokens and capabilities.
- **Session Expiration Helpers**: `isTokenExpired`, `getTokenRemainingTimeMs`.

## Installation

```bash
jmpm add @dwellentix/auth
# or
npm install @dwellentix/auth
```

## Quickstart

```typescript
import {
  parseJwt,
  isTokenExpired,
  hasRole,
  hasPermission,
  hasOdeCapability
} from '@dwellentix/auth';

// 1. Decode token
const claims = parseJwt(accessToken);

// 2. Check expiration (with default 30s safety buffer)
if (isTokenExpired(claims)) {
  console.log('Token needs refresh!');
}

// 3. Check roles & permissions
if (hasRole(claims, ['admin', 'landlord'])) {
  // perform privileged action
}
```

