import fs from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { PackageManifest, ManifestValidationError, JMPM_VERSION } from '@jmpm/shared';

const SCOPED_PACKAGE_REGEX = /^@([a-z0-9~-][a-z0-9._~-]*)\/([a-z0-9~-][a-z0-9._~-]*)$/;
const REGULAR_PACKAGE_REGEX = /^[a-z0-9~-][a-z0-9._~-]*$/;

export const CANDIDATE_MANIFEST_FILES = [
  'package.json'
];

/**
 * Strips single-line and multi-line comments and trailing commas from JSONC text.
 * Preserves all string literals safely.
 */
export function stripJsonCommentsAndTrailingCommas(input: string): string {
  let output = '';
  let inString = false;
  let isEscaped = false;
  let inSingleComment = false;
  let inMultiComment = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (inSingleComment) {
      if (ch === '\n' || ch === '\r') {
        inSingleComment = false;
        output += ch;
      }
      continue;
    }

    if (inMultiComment) {
      if (ch === '*' && next === '/') {
        inMultiComment = false;
        i++; // skip /
      }
      continue;
    }

    if (inString) {
      output += ch;
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === '\\') {
        isEscaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    // Outside string and comments
    if (ch === '"') {
      inString = true;
      output += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inSingleComment = true;
      i++; // skip second /
      continue;
    }

    if (ch === '/' && next === '*') {
      inMultiComment = true;
      i++; // skip *
      continue;
    }

    output += ch;
  }

  // Remove trailing commas before closing braces/brackets
  return output.replace(/,\s*([}\]])/g, '$1');
}

export function parseJsonc<T = unknown>(raw: string): T {
  const sanitized = stripJsonCommentsAndTrailingCommas(raw);
  return JSON.parse(sanitized) as T;
}

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

  if (pkg.scripts !== undefined) {
    if (typeof pkg.scripts !== 'object' || pkg.scripts === null || Array.isArray(pkg.scripts)) {
      throw new ManifestValidationError('"scripts" must be an object of script names and commands');
    }
    for (const [k, v] of Object.entries(pkg.scripts as Record<string, unknown>)) {
      if (typeof v !== 'string' && !Array.isArray(v)) {
        throw new ManifestValidationError(`Script "${k}" must be a string command or an array of command strings`);
      }
      if (Array.isArray(v) && !v.every((item) => typeof item === 'string')) {
        throw new ManifestValidationError(`Script "${k}" pipeline array must contain only strings`);
      }
    }
  }
}

export async function resolveManifestPath(dirOrFilePath: string): Promise<string> {
  try {
    const stat = await fs.stat(dirOrFilePath);
    if (stat.isFile()) {
      return dirOrFilePath;
    }
    if (stat.isDirectory()) {
      for (const candidate of CANDIDATE_MANIFEST_FILES) {
        const candidatePath = path.join(dirOrFilePath, candidate);
        try {
          await fs.access(candidatePath);
          return candidatePath;
        } catch {
          // try next
        }
      }
      return path.join(dirOrFilePath, 'package.json');
    }
  } catch {
    // If stat fails, return as path
  }
  return dirOrFilePath;
}

export async function readPackageManifest(dirOrFilePath: string): Promise<PackageManifest> {
  const filePath = await resolveManifestPath(dirOrFilePath);
  try {
    await fs.access(filePath);
  } catch {
    throw new ManifestValidationError(`Could not find manifest file at ${dirOrFilePath}`);
  }

  const raw = await fs.readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (err: unknown) {
    throw new ManifestValidationError(
      `Syntax error parsing manifest in ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }


  validatePackageManifest(parsed);
  return parsed;
}

export async function writePackageManifest(
  dirOrFilePath: string,
  manifest: PackageManifest
): Promise<void> {
  validatePackageManifest(manifest);
  const filePath = await resolveManifestPath(dirOrFilePath);

  const content = JSON.stringify(manifest, null, 2) + '\n';
  await fs.writeFile(filePath, content, 'utf8');
}

export interface EngineCheckResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates engines (node, jmpm) and packageManager constraints.
 */
export function checkEngines(
  manifest: PackageManifest,
  currentJmpmVersion: string = JMPM_VERSION
): EngineCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (manifest.engines) {
    if (typeof manifest.engines.node === 'string') {
      const nodeVersion = process.version;
      if (!semver.satisfies(nodeVersion, manifest.engines.node)) {
        errors.push(
          `Incompatible Node engine: project requires "${manifest.engines.node}", but running Node ${nodeVersion}`
        );
      }
    }

    if (typeof manifest.engines.jmpm === 'string') {
      if (!semver.satisfies(currentJmpmVersion, manifest.engines.jmpm)) {
        errors.push(
          `Incompatible JMPM engine: project requires jmpm "${manifest.engines.jmpm}", but running jmpm@${currentJmpmVersion}`
        );
      }
    }
  }

  if (manifest.packageManager && typeof manifest.packageManager === 'string') {
    const [pmName, pmVersion] = manifest.packageManager.split('@');
    if (pmName === 'jmpm' && pmVersion) {
      if (!semver.satisfies(currentJmpmVersion, `^${pmVersion}`) && !semver.satisfies(currentJmpmVersion, pmVersion)) {
        warnings.push(
          `Project specifies packageManager "${manifest.packageManager}", currently running jmpm@${currentJmpmVersion}`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Materializes embeddedFiles declared in manifest directly into workspace.
 */
export async function generateEmbeddedFiles(
  projectDir: string,
  manifest: PackageManifest,
  options: { overwrite?: boolean } = {}
): Promise<string[]> {
  const generated: string[] = [];
  if (!manifest.embeddedFiles || typeof manifest.embeddedFiles !== 'object') {
    return generated;
  }

  const rootResolved = path.resolve(projectDir);

  for (const [relPath, content] of Object.entries(manifest.embeddedFiles)) {
    const targetPath = path.resolve(projectDir, relPath);
    // Security check: Guard against directory traversal
    if (!targetPath.startsWith(rootResolved)) {
      throw new ManifestValidationError(`Security violation: Embedded file path "${relPath}" escapes project root`);
    }

    const fileContent = Array.isArray(content) ? content.join('\n') + '\n' : String(content);

    if (!options.overwrite) {
      try {
        await fs.access(targetPath);
        // If file already exists and overwrite is false, skip to protect user data
        continue;
      } catch {
        // file doesn't exist, proceed
      }
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, fileContent, 'utf8');
    generated.push(relPath);
  }

  return generated;
}

/**
 * Generates modern TypeScript configuration preset.
 */
export function generateTsConfig(manifest: PackageManifest): Record<string, unknown> {
  const preset = manifest.typescript?.preset || 'node';
  const outDir = manifest.typescript?.outDir || (preset === 'node20' ? './lib' : './dist');
  const rootDir = manifest.typescript?.rootDir || './src';

  let baseConfig: Record<string, unknown>;

  switch (preset) {
    case 'node24':
    case 'node':
      baseConfig = {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          declaration: true,
          rootDir,
          outDir
        },
        include: [`${rootDir.replace(/^\.\//, '')}/**/*`],
        exclude: ['node_modules', outDir.replace(/^\.\//, '')]
      };
      break;

    case 'node20':
      baseConfig = {
        compilerOptions: {
          target: 'ES2020',
          module: 'commonjs',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          declaration: true,
          rootDir,
          outDir
        },
        include: [`${rootDir.replace(/^\.\//, '')}/**/*`],
        exclude: ['node_modules', outDir.replace(/^\.\//, '')]
      };
      break;

    case 'react':
      baseConfig = {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          jsx: 'react-jsx',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          rootDir,
          outDir
        },
        include: [`${rootDir.replace(/^\.\//, '')}/**/*`],
        exclude: ['node_modules', outDir.replace(/^\.\//, '')]
      };
      break;

    case 'lib':
      baseConfig = {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          declaration: true,
          declarationMap: true,
          sourceMap: true,
          rootDir,
          outDir
        },
        include: [`${rootDir.replace(/^\.\//, '')}/**/*`],
        exclude: ['node_modules', outDir.replace(/^\.\//, '')]
      };
      break;

    default:
      baseConfig = {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          declaration: true,
          rootDir,
          outDir
        },
        include: [`${rootDir.replace(/^\.\//, '')}/**/*`],
        exclude: ['node_modules', outDir.replace(/^\.\//, '')]
      };
  }

  if (manifest.typescript?.compilerOptions) {
    baseConfig.compilerOptions = {
      ...(baseConfig.compilerOptions as Record<string, unknown>),
      ...manifest.typescript.compilerOptions
    };
  }

  return baseConfig;
}

export async function writeTsConfig(projectDir: string, manifest: PackageManifest): Promise<string> {
  const tsConfig = generateTsConfig(manifest);
  const filePath = path.join(projectDir, 'tsconfig.json');
  await fs.writeFile(filePath, JSON.stringify(tsConfig, null, 2) + '\n', 'utf8');
  return filePath;
}

/**
 * Synchronizes custom jmpm manifest to standard package.json for third-party npm tools.
 */
export async function syncToStandardPackageJson(
  projectDir: string,
  manifest: PackageManifest
): Promise<string> {
  const cleanManifest: Record<string, unknown> = { ...manifest };

  // Convert array scripts to standard "cmd1 && cmd2" strings for legacy npm/yarn
  if (cleanManifest.scripts && typeof cleanManifest.scripts === 'object') {
    const syncedScripts: Record<string, string> = {};
    for (const [name, cmd] of Object.entries(cleanManifest.scripts)) {
      if (Array.isArray(cmd)) {
        syncedScripts[name] = cmd.join(' && ');
      } else if (typeof cmd === 'string') {
        syncedScripts[name] = cmd;
      }
    }
    cleanManifest.scripts = syncedScripts;
  }

  const standardPath = path.join(projectDir, 'package.json');
  await fs.writeFile(standardPath, JSON.stringify(cleanManifest, null, 2) + '\n', 'utf8');
  return standardPath;
}
