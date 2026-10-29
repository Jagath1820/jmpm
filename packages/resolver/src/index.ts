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
    existingPackages: Record<string, ResolvedPackage> = {}
  ): Promise<Map<string, ResolvedPackage>> {
    this.resolvedMap.clear();
    this.inProgress.clear();

    // Populate existing packages if provided
    for (const [key, pkg] of Object.entries(existingPackages)) {
      this.resolvedMap.set(key, pkg);
    }

    const queue: Array<{ name: string; range: string }> = [];
    for (const [name, range] of Object.entries(rootDependencies)) {
      queue.push({ name, range });
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      const keyPrefix = `${current.name}@${current.range}`;

      if (this.inProgress.has(keyPrefix)) {
        continue;
      }
      this.inProgress.add(keyPrefix);

      const doc = await this.getMetadata(current.name);
      const versionMeta = this.findBestVersion(doc, current.range);
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
        for (const [depName, depRange] of Object.entries(resolvedPkg.dependencies)) {
          queue.push({ name: depName, range: depRange });
        }
      }
    }

    return this.resolvedMap;
  }
}

