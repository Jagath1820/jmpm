import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface BuiltinPackage {
  name: string;
  version: string;
  dir: string;
  manifest: Record<string, unknown>;
}

const cachedBuiltins = new Map<string, BuiltinPackage>();

function getCandidatePackagesDirs(): string[] {
  const candidates: string[] = [];
  if (process.env.JMPM_PACKAGES_DIR) {
    candidates.push(process.env.JMPM_PACKAGES_DIR);
  }

  // Canonical workspace path on this system
  candidates.push('C:\\Users\\jagat\\Documents\\Dwellentix\\jmpm\\packages');

  // Relative to process.cwd()
  candidates.push(path.resolve(process.cwd(), 'jmpm', 'packages'));
  candidates.push(path.resolve(process.cwd(), '..', 'jmpm', 'packages'));

  // User home directory
  candidates.push(path.join(os.homedir(), '.jmpm', 'builtins'));

  return candidates;
}

export function scanBuiltinPackages(): Map<string, BuiltinPackage> {
  if (cachedBuiltins.size > 0) {
    return cachedBuiltins;
  }

  for (const candidateDir of getCandidatePackagesDirs()) {
    if (!fs.existsSync(candidateDir)) {
      continue;
    }

    try {
      const entries = fs.readdirSync(candidateDir);
      for (const entry of entries) {
        const pkgDir = path.join(candidateDir, entry);
        const pkgJsonPath = path.join(pkgDir, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
            if (manifest.name && typeof manifest.name === 'string') {
              // Register internal proprietary packages
              if (
                manifest.name.startsWith('@dwellentix/') ||
                manifest.name.startsWith('@ode/') ||
                entry === 'dwellentix-core' ||
                entry === 'ode-core'
              ) {
                cachedBuiltins.set(manifest.name, {
                  name: manifest.name,
                  version: manifest.version || '1.0.0',
                  dir: pkgDir,
                  manifest
                });
              }
            }
          } catch {
            // ignore invalid json
          }
        }
      }
    } catch {
      // ignore readdir error
    }
  }

  return cachedBuiltins;
}

export function getBuiltinPackage(name: string): BuiltinPackage | undefined {
  const map = scanBuiltinPackages();
  return map.get(name);
}

