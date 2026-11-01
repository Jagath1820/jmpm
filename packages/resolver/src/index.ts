import semver from 'semver';
import {
  ResolvedPackage,
  RegistryPackageDocument,
  VersionNotFoundError,
  RegistryVersionMetadata
} from '@jmpm/shared';
import { RegistryClient } from '@jmpm/registry-client';

export interface ResolveGraphOptions {
  dependencies: Record<string, string>;
  registryClient: RegistryClient;
  existingPackages?: Record<string, ResolvedPackage>;
}

export class DependencyResolver {
  private registryClient: RegistryClient;
  private metadataCache = new Map<string, RegistryPackageDocument>();
  private resolvedMap = new Map<string, ResolvedPackage>();
  private inProgress = new Set<string>();

  constructor(registryClient: RegistryClient) {
    this.registryClient = registryClient;
  }

  public async getMetadata(packageName: string): Promise<RegistryPackageDocument> {
    if (this.metadataCache.has(packageName)) {
      return this.metadataCache.get(packageName)!;
    }
    const doc = await this.registryClient.getPackageMetadata(packageName);
    this.metadataCache.set(packageName, doc);
    return doc;
  }

  public findBestVersion(
    doc: RegistryPackageDocument,
    rangeOrTag: string
  ): RegistryVersionMetadata {
    // 1. Check dist-tags (e.g. "latest", "beta", "next")
    if (doc['dist-tags'] && doc['dist-tags'][rangeOrTag]) {
      const tagVersion = doc['dist-tags'][rangeOrTag];
      if (tagVersion && doc.versions[tagVersion]) {
        return doc.versions[tagVersion];
      }
    }

    // 2. Find max satisfying semver
    const availableVersions = Object.keys(doc.versions);
    let targetRange = rangeOrTag === '*' || !rangeOrTag ? '*' : rangeOrTag;

    const matched = semver.maxSatisfying(availableVersions, targetRange);
    if (matched && doc.versions[matched]) {
      return doc.versions[matched];
    }

    // 3. Fallback to latest tag if available
    if (doc['dist-tags']?.latest && doc.versions[doc['dist-tags'].latest]) {
      return doc.versions[doc['dist-tags'].latest];
    }

    throw new VersionNotFoundError(doc.name, rangeOrTag);
  }

  public async resolve(
    rootDependencies: Record<string, string>,
    existingPackages: Record<string, ResolvedPackage> = {},
    options: { overrides?: Record<string, string> } = {}
  ): Promise<Map<string, ResolvedPackage>> {
    this.resolvedMap.clear();
    this.inProgress.clear();

    const overrides = options.overrides || {};

    // Populate existing packages if provided
    for (const [key, pkg] of Object.entries(existingPackages)) {
      this.resolvedMap.set(key, pkg);
    }

    const queue: Array<{ name: string; range: string; optional?: boolean }> = [];
    for (const [name, range] of Object.entries(rootDependencies)) {
      const targetRange = overrides[name] || range;
      queue.push({ name, range: targetRange });
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      const effectiveRange = overrides[current.name] || current.range;
      const keyPrefix = `${current.name}@${effectiveRange}`;

      if (this.inProgress.has(keyPrefix)) {
        continue;
      }
      this.inProgress.add(keyPrefix);

      let doc: RegistryPackageDocument;
      try {
        doc = await this.getMetadata(current.name);
      } catch (err) {
        if (current.optional) {
          // Gracefully ignore missing optional dependencies
          continue;
        }
        throw err;
      }

      let versionMeta: RegistryVersionMetadata;
      try {
        versionMeta = this.findBestVersion(doc, effectiveRange);
      } catch (err) {
        if (current.optional) {
          continue;
        }
        throw err;
      }

      // Check OS & CPU platform compatibility
      const rawMeta = versionMeta as Record<string, any>;
      if (rawMeta.os && Array.isArray(rawMeta.os)) {
        const currentOs = process.platform;
        const osMatch = rawMeta.os.some((o: string) => o === currentOs || (o.startsWith('!') && o.slice(1) !== currentOs));
        if (!osMatch && current.optional) {
          continue;
        }
      }
      if (rawMeta.cpu && Array.isArray(rawMeta.cpu)) {
        const currentCpu = process.arch;
        const cpuMatch = rawMeta.cpu.some((c: string) => c === currentCpu || (c.startsWith('!') && c.slice(1) !== currentCpu));
        if (!cpuMatch && current.optional) {
          continue;
        }
      }

      const resolvedKey = `${versionMeta.name}@${versionMeta.version}`;

      if (this.resolvedMap.has(resolvedKey)) {
        continue;
      }

      // Normalize bin configuration
      let binMap: Record<string, string> | undefined;
      if (typeof versionMeta.bin === 'string') {
        const binName = versionMeta.name.startsWith('@')
          ? versionMeta.name.split('/')[1]
          : versionMeta.name;
        binMap = { [binName]: versionMeta.bin };
      } else if (typeof versionMeta.bin === 'object' && versionMeta.bin !== null) {
        binMap = { ...versionMeta.bin };
      }

      const resolvedPkg: ResolvedPackage = {
        name: versionMeta.name,
        version: versionMeta.version,
        resolved: versionMeta.dist.tarball,
        integrity: versionMeta.dist.integrity || '',
        dependencies: versionMeta.dependencies || {},
        bin: binMap
      };

      this.resolvedMap.set(resolvedKey, resolvedPkg);

      // Enqueue transitive dependencies
      if (resolvedPkg.dependencies) {
        for (const [depName, depRange] of Object.entries(resolvedPkg.dependencies as Record<string, string>)) {
          const finalDepRange = overrides[depName] || depRange;
          queue.push({ name: depName, range: finalDepRange });
        }
      }

      // Enqueue optionalDependencies
      if (rawMeta.optionalDependencies && typeof rawMeta.optionalDependencies === 'object') {
        for (const [depName, depRange] of Object.entries(rawMeta.optionalDependencies as Record<string, string>)) {
          const finalDepRange = overrides[depName] || depRange;
          queue.push({ name: depName, range: finalDepRange, optional: true });
        }
      }
    }

    return this.resolvedMap;
  }
}

