import fs from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { PackageManifest, ManifestValidationError } from '@jmpm/shared';

const SCOPED_PACKAGE_REGEX = /^@([a-z0-9~-][a-z0-9._~-]*)\/([a-z0-9~-][a-z0-9._~-]*)$/;
const REGULAR_PACKAGE_REGEX = /^[a-z0-9~-][a-z0-9._~-]*$/;

export function validatePackageName(name: string): boolean {
  if (!name || name.length > 214) return false;
  if (name.startsWith('.') || name.startsWith('_')) return false;
  if (name.trim() !== name) return false;
  if (name.includes('/') && !name.startsWith('@')) return false;

  if (name.startsWith('@')) {
    return SCOPED_PACKAGE_REGEX.test(name);
  }
  return REGULAR_PACKAGE_REGEX.test(name);
}

export function validatePackageManifest(manifest: unknown): asserts manifest is PackageManifest {
  if (!manifest || typeof manifest !== 'object') {
    throw new ManifestValidationError('Manifest must be a JSON object');
  }

  const pkg = manifest as Record<string, unknown>;

  if (typeof pkg.name !== 'string' || !validatePackageName(pkg.name)) {
    throw new ManifestValidationError(
      `Invalid package name: "${pkg.name}". Package names must be lowercase, URL-friendly, and not start with . or _`
    );
  }

  if (typeof pkg.version !== 'string' || !semver.valid(pkg.version)) {
    throw new ManifestValidationError(`Invalid semver version: "${pkg.version}"`);
  }

  const depFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  for (const field of depFields) {
    if (pkg[field] !== undefined) {
      if (typeof pkg[field] !== 'object' || pkg[field] === null || Array.isArray(pkg[field])) {
        throw new ManifestValidationError(`"${field}" must be an object of package names and version ranges`);
      }
    }
  }
}

export async function readPackageManifest(dirOrFilePath: string): Promise<PackageManifest> {
  let filePath = dirOrFilePath;
  try {
    const stat = await fs.stat(dirOrFilePath);
    if (stat.isDirectory()) {
      filePath = path.join(dirOrFilePath, 'package.json');
    }
  } catch (err: unknown) {
    throw new ManifestValidationError(`Could not find package.json at ${dirOrFilePath}`);
  }

  const raw = await fs.readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ManifestValidationError(`Syntax error parsing JSON in ${filePath}`);
  }

  validatePackageManifest(parsed);
  return parsed;
}

export async function writePackageManifest(
  dirOrFilePath: string,
  manifest: PackageManifest
): Promise<void> {
  validatePackageManifest(manifest);
  let filePath = dirOrFilePath;
  const stat = await fs.stat(dirOrFilePath).catch(() => null);
  if (stat && stat.isDirectory()) {
    filePath = path.join(dirOrFilePath, 'package.json');
  }

  const content = JSON.stringify(manifest, null, 2) + '\n';
  await fs.writeFile(filePath, content, 'utf8');
}

