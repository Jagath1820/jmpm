export class JmpmError extends Error {
  constructor(message: string, public code: string = 'ERR_JMPM') {
    super(message);
    this.name = 'JmpmError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PackageNotFoundError extends JmpmError {
  constructor(packageName: string, registryUrl: string) {
    super(
      `Package "${packageName}" not found in registry "${registryUrl}"`,
      'ERR_PACKAGE_NOT_FOUND'
    );
    this.name = 'PackageNotFoundError';
  }
}

export class VersionNotFoundError extends JmpmError {
  constructor(packageName: string, versionOrRange: string) {
    super(
      `No matching version found for "${packageName}@${versionOrRange}"`,
      'ERR_VERSION_NOT_FOUND'
    );
    this.name = 'VersionNotFoundError';
  }
}

export class ChecksumMismatchError extends JmpmError {
  constructor(packageName: string, expected: string, actual: string) {
    super(
      `Integrity checksum mismatch for "${packageName}". Expected ${expected}, got ${actual}`,
      'ERR_CHECKSUM_MISMATCH'
    );
    this.name = 'ChecksumMismatchError';
  }
}

export class ManifestValidationError extends JmpmError {
  constructor(message: string) {
    super(`Invalid package.json: ${message}`, 'ERR_MANIFEST_INVALID');
    this.name = 'ManifestValidationError';
  }
}

export class SecurityError extends JmpmError {
  constructor(message: string) {
    super(`Security check failed: ${message}`, 'ERR_SECURITY_VIOLATION');
    this.name = 'SecurityError';
  }
}

