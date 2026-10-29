import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PackageManifest,
  ResolvedPackage,
  logger,
  JmpmError
} from '@jmpm/shared';
import { loadConfig } from '@jmpm/config';
import { AuthManager } from '@jmpm/auth';
import { ContentAddressedCache } from '@jmpm/cache';
import { RegistryClient } from '@jmpm/registry-client';
import { DependencyResolver } from '@jmpm/resolver';
import {
  readPackageManifest,
  writePackageManifest
} from '@jmpm/package-manifest';
import { packPackage, PackResult } from '@jmpm/pack';
import {
  readLockfile,
  writeLockfile,
  resolvedMapToLockfile
} from '@jmpm/lockfile';
import { PackageInstaller } from '@jmpm/installer';

export interface CommandContextOptions {
  cwd?: string;
  registry?: string;
  token?: string;
  saveDev?: boolean;
}

export class JmpmOrchestrator {
  private cwd: string;
  private config: ReturnType<typeof loadConfig>;
  private authManager: AuthManager;
  private cache: ContentAddressedCache;
  private client: RegistryClient;

  constructor(options: CommandContextOptions = {}) {
    this.cwd = options.cwd || process.cwd();
    this.config = loadConfig({
      cwd: this.cwd,
      cliFlags: {
        registry: options.registry,
        token: options.token
      }
    });

    this.authManager = new AuthManager();
    this.cache = new ContentAddressedCache(this.config.storeDir);
    this.client = new RegistryClient({
      registryUrl: this.config.registry,
      token: this.config.token,
      cache: this.cache,
      userAgent: this.config.userAgent
    });
  }

  public async init(): Promise<void> {
    await this.cache.init();
    if (!this.config.token) {
      const savedToken = await this.authManager.getToken(this.config.registry);
      if (savedToken) {
        this.client.setToken(savedToken);
      }
    }
  }

  public async install(): Promise<void> {
    await this.init();
    logger.step('resolve', 'Reading project manifest and lockfile...');

    const manifest = await readPackageManifest(this.cwd);
    const lockfile = await readLockfile(this.cwd);

    const rootDeps: Record<string, string> = {
      ...(manifest.dependencies || {}),
      ...(manifest.devDependencies || {})
    };

    if (Object.keys(rootDeps).length === 0) {
      logger.info('No dependencies found in package.json to install.');
      return;
    }

    // Prepare resolver
    const resolver = new DependencyResolver(this.client);
    const existingPackages: Record<string, ResolvedPackage> = {};

    if (lockfile) {
      for (const [key, pkg] of Object.entries(lockfile.packages)) {
        const atIdx = key.lastIndexOf('@');
        const name = key.slice(0, atIdx);
        existingPackages[key] = {
          name,
          version: pkg.version,
          resolved: pkg.resolved,
          integrity: pkg.integrity,
          dependencies: pkg.dependencies || {},
          bin: pkg.bin
        };
      }
    }

    logger.step('resolve', `Resolving ${Object.keys(rootDeps).length} direct dependencies...`);
    const resolvedGraph = await resolver.resolve(rootDeps, existingPackages);

    logger.step('fetch', `Fetching and linking ${resolvedGraph.size} packages to virtual-store...`);
    const installer = new PackageInstaller(this.cwd);
    await installer.install({
      projectDir: this.cwd,
      packages: resolvedGraph,
      directDependencies: manifest.dependencies || {},
      directDevDependencies: manifest.devDependencies || {},
      client: this.client,
      cache: this.cache
    });

    // Write deterministic lockfile
    logger.step('lockfile', 'Writing jmpm-lock.yaml...');
    const newLockfile = resolvedMapToLockfile(
      resolvedGraph,
      manifest.dependencies || {},
      manifest.devDependencies || {}
    );
    await writeLockfile(this.cwd, newLockfile);

    logger.success(`Successfully installed ${resolvedGraph.size} packages!`);
  }

  public async add(packages: string[], isDev: boolean = false): Promise<void> {
    await this.init();
    const manifest = await readPackageManifest(this.cwd);

    for (const pkgSpec of packages) {
      logger.step('add', `Finding matching version for "${pkgSpec}"...`);
      let name = pkgSpec;
      let requestedRange = 'latest';

      if (pkgSpec.startsWith('@')) {
        const slashIdx = pkgSpec.indexOf('/');
        const atIdx = pkgSpec.indexOf('@', slashIdx + 1);
        if (atIdx !== -1) {
          name = pkgSpec.slice(0, atIdx);
          requestedRange = pkgSpec.slice(atIdx + 1);
        }
      } else {
        const atIdx = pkgSpec.indexOf('@');
        if (atIdx !== -1) {
          name = pkgSpec.slice(0, atIdx);
          requestedRange = pkgSpec.slice(atIdx + 1);
        }
      }

      const resolver = new DependencyResolver(this.client);
      const doc = await resolver.getMetadata(name);
      const versionMeta = resolver.findBestVersion(doc, requestedRange);

      const semverPrefix = requestedRange.startsWith('~') ? '~' : '^';
      const versionSpec = `${semverPrefix}${versionMeta.version}`;

      if (isDev) {
        manifest.devDependencies = manifest.devDependencies || {};
        manifest.devDependencies[name] = versionSpec;
      } else {
        manifest.dependencies = manifest.dependencies || {};
        manifest.dependencies[name] = versionSpec;
      }

      logger.info(`Added ${name}@${versionSpec} to ${isDev ? 'devDependencies' : 'dependencies'}`);
    }

    await writePackageManifest(this.cwd, manifest);
    await this.install();
  }

  public async remove(packages: string[]): Promise<void> {
    await this.init();
    const manifest = await readPackageManifest(this.cwd);

    for (const name of packages) {
      if (manifest.dependencies && manifest.dependencies[name]) {
        delete manifest.dependencies[name];
        logger.info(`Removed "${name}" from dependencies`);
      }
      if (manifest.devDependencies && manifest.devDependencies[name]) {
        delete manifest.devDependencies[name];
        logger.info(`Removed "${name}" from devDependencies`);
      }
    }

    await writePackageManifest(this.cwd, manifest);
    await this.install();
  }

  public async pack(): Promise<PackResult> {
    logger.step('pack', `Packaging ${this.cwd}...`);
    const result = await packPackage(this.cwd);
    const destPath = path.join(this.cwd, result.filename);
    await fs.writeFile(destPath, result.tarballBuffer);
    logger.success(`Created archive: ${result.filename} (${(result.tarballBuffer.length / 1024).toFixed(2)} KB)`);
    return result;
  }

  public async publish(): Promise<void> {
    await this.init();
    const manifest = await readPackageManifest(this.cwd);
    const packResult = await packPackage(this.cwd);

    const token = this.config.token || (await this.authManager.getToken(this.config.registry));
    if (!token) {
      throw new JmpmError(`Authentication required. Run 'jmpm login' for registry "${this.config.registry}"`);
    }

    const tarballBase64 = packResult.tarballBuffer.toString('base64');
    const tarballFileName = packResult.filename;

    const couchDoc = {
      _id: manifest.name,
      name: manifest.name,
      description: manifest.description || '',
      'dist-tags': {
        latest: manifest.version
      },
      versions: {
        [manifest.version]: {
          ...manifest,
          _id: `${manifest.name}@${manifest.version}`,
          dist: {
            ...packResult.dist,
            tarball: `${this.config.registry}/${manifest.name}/-/${tarballFileName}`
          }
        }
      },
      _attachments: {
        [tarballFileName]: {
          content_type: 'application/octet-stream',
          data: tarballBase64,
          length: packResult.tarballBuffer.length
        }
      }
    };

    logger.step('publish', `Publishing ${manifest.name}@${manifest.version} to ${this.config.registry}...`);
    await this.client.publish(couchDoc, token);
    logger.success(`+ ${manifest.name}@${manifest.version} successfully published!`);
  }

  public async login(username: string, password: string, email?: string): Promise<void> {
    logger.step('auth', `Logging in as "${username}" to ${this.config.registry}...`);
    const { token } = await this.client.login(username, password, email);
    await this.authManager.saveToken(this.config.registry, token);
    logger.success(`Logged in successfully! Token saved to ~/.jmpmrc`);
  }

  public async whoami(): Promise<string> {
    await this.init();
    const token = this.config.token || (await this.authManager.getToken(this.config.registry));
    if (!token) {
      throw new JmpmError(`Not logged in to ${this.config.registry}`);
    }
    const { username } = await this.client.whoami(token);
    logger.info(`Logged in as "${username}" on ${this.config.registry}`);
    return username;
  }

  public async cleanCache(): Promise<void> {
    await this.cache.clean();
    logger.success('Local content-addressed store cache cleared.');
  }
}
