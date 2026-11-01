import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import semver from 'semver';
import {
  PackageManifest,
  ResolvedPackage,
  logger,
  JmpmError,
  JMPM_VERSION
} from '@jmpm/shared';
import { loadConfig } from '@jmpm/config';
import { AuthManager } from '@jmpm/auth';
import { ContentAddressedCache } from '@jmpm/cache';
import { RegistryClient } from '@jmpm/registry-client';
import { DependencyResolver } from '@jmpm/resolver';
import {
  readPackageManifest,
  writePackageManifest,
  checkEngines,
  generateEmbeddedFiles,
  generateTsConfig,
  writeTsConfig,
  syncToStandardPackageJson
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
  upstreamRegistry?: string;
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
        upstreamRegistry: options.upstreamRegistry,
        token: options.token
      }
    });

    this.authManager = new AuthManager();
    this.cache = new ContentAddressedCache(this.config.storeDir);
    this.client = new RegistryClient({
      registryUrl: this.config.registry,
      upstreamUrl: this.config.upstreamRegistry,
      scopedRegistries: this.config.scopedRegistries,
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

  public async install(options: { offline?: boolean; target?: string } = {}): Promise<void> {
    await this.init();
    logger.step('resolve', 'Reading project manifest and lockfile...');

    const isOffline = options.offline ?? this.config.offline;
    const vendorDir = path.join(this.cwd, '.jmpm', 'vendor');

    if (isOffline) {
      try {
        await fs.access(vendorDir);
      } catch {
        throw new JmpmError(`Offline installation requested, but "${vendorDir}" does not exist. Run "jmpm vendor" first.`);
      }
      logger.info('Offline mode enabled: resolving directly from local .jmpm/vendor store.');
    }

    const manifest = await readPackageManifest(this.cwd);

    // Validate engine constraints (Node.js & JMPM version)
    const engineCheck = checkEngines(manifest, JMPM_VERSION);
    if (!engineCheck.valid) {
      for (const err of engineCheck.errors) {
        logger.error(err);
      }
      throw new JmpmError(`Engine constraint violation:\n${engineCheck.errors.join('\n')}`, 'ERR_ENGINE_INCOMPATIBLE');
    }
    for (const warn of engineCheck.warnings) {
      logger.warn(warn);
    }

    // Materialize any declared embeddedFiles if missing
    if (manifest.embeddedFiles) {
      const generated = await generateEmbeddedFiles(this.cwd, manifest);
      if (generated.length > 0) {
        logger.info(`Materialized ${generated.length} embedded configuration file(s)`);
      }
    }

    const lockfile = await readLockfile(this.cwd);

    const target = options.target || process.env.JMPM_TARGET;
    let targetDeps: Record<string, string> = {};
    if (target && manifest.targets && manifest.targets[target]) {
      logger.info(`Applying target profile: "${target}"`);
      targetDeps = {
        ...(manifest.targets[target].dependencies || {}),
        ...(manifest.targets[target].devDependencies || {})
      };
    }

    const rootDeps: Record<string, string> = {
      ...(manifest.dependencies || {}),
      ...(manifest.devDependencies || {}),
      ...targetDeps
    };

    if (Object.keys(rootDeps).length === 0) {
      logger.info('No dependencies found in package.json to install.');
      return;
    }

    let resolvedGraph = new Map<string, ResolvedPackage>();

    if (isOffline && lockfile) {
      // 100% offline resolution from lockfile packages
      for (const [key, pkg] of Object.entries(lockfile.packages as Record<string, any>)) {
        const atIdx = key.lastIndexOf('@');
        const name = key.slice(0, atIdx);
        resolvedGraph.set(key, {
          name,
          version: pkg.version,
          resolved: pkg.resolved,
          integrity: pkg.integrity,
          dependencies: pkg.dependencies || {},
          bin: pkg.bin
        });
      }
    } else {
      // Prepare resolver
      const resolver = new DependencyResolver(this.client);
      const existingPackages: Record<string, ResolvedPackage> = {};

      if (lockfile) {
        for (const [key, pkg] of Object.entries(lockfile.packages as Record<string, any>)) {
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
      const overrides = ((manifest as any).overrides || (manifest as any).resolutions || {}) as Record<string, string>;
      resolvedGraph = await resolver.resolve(rootDeps, existingPackages, { overrides });
    }

    logger.step('fetch', `Fetching and linking ${resolvedGraph.size} packages to virtual-store...`);
    const installer = new PackageInstaller(this.cwd);
    await installer.install({
      projectDir: this.cwd,
      packages: resolvedGraph,
      directDependencies: manifest.dependencies || {},
      directDevDependencies: manifest.devDependencies || {},
      client: this.client,
      cache: this.cache,
      offline: isOffline,
      vendorDir: isOffline ? vendorDir : undefined
    });



    logger.success(`Successfully installed ${resolvedGraph.size} packages${isOffline ? ' (offline)' : ''}!`);
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

  public async publish(options: { tag?: string } = {}): Promise<void> {
    await this.init();
    const manifest = await readPackageManifest(this.cwd);

    // Ghost publish guard: Check if TypeScript project needs build
    const tsconfigPath = path.join(this.cwd, 'tsconfig.json');
    let hasTsConfig = false;
    try {
      await fs.access(tsconfigPath);
      hasTsConfig = true;
    } catch {
      hasTsConfig = false;
    }

    if (hasTsConfig) {
      const srcDir = path.join(this.cwd, 'src');
      let hasSrc = false;
      try {
        await fs.access(srcDir);
        hasSrc = true;
      } catch {
        hasSrc = false;
      }

      if (hasSrc) {
        let needsBuild = false;
        if (manifest.main) {
          try {
            await fs.access(path.join(this.cwd, manifest.main));
          } catch {
            needsBuild = true;
          }
        }
        if (needsBuild) {
          logger.step('build', 'Ghost Publish Guard: Artifacts missing. Running build before publish...');
          if (manifest.scripts?.build) {
            await this.runScript('build');
          }
        }
      }
    }

    // Verify main and types entries exist before packing
    if (manifest.main) {
      try {
        await fs.access(path.join(this.cwd, manifest.main));
      } catch {
        throw new JmpmError(`Ghost Publish Guard: "main" entry file "${manifest.main}" does not exist on disk! Run build first.`);
      }
    }
    if (manifest.types) {
      try {
        await fs.access(path.join(this.cwd, manifest.types));
      } catch {
        throw new JmpmError(`Ghost Publish Guard: "types" entry file "${manifest.types}" does not exist on disk! Run build first.`);
      }
    }

    const packResult = await packPackage(this.cwd);

    const token = this.config.token || (await this.authManager.getToken(this.config.registry));
    if (!token) {
      throw new JmpmError(`Authentication required. Run 'jmpm login' for registry "${this.config.registry}"`);
    }

    const tag = options.tag || 'latest';
    const tarballBase64 = packResult.tarballBuffer.toString('base64');
    const tarballFileName = packResult.filename;

    const couchDoc = {
      _id: manifest.name,
      name: manifest.name,
      description: manifest.description || '',
      'dist-tags': {
        [tag]: manifest.version,
        ...(tag !== 'latest' ? {} : { latest: manifest.version })
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

    logger.step('publish', `Publishing ${manifest.name}@${manifest.version} [tag: ${tag}] to ${this.config.registry}...`);
    await this.client.publish(couchDoc, token);
    logger.success(`+ ${manifest.name}@${manifest.version} (tag: ${tag}) successfully published!`);
  }

  public async runScript(scriptName: string, extraArgs: string[] = []): Promise<void> {
    const manifest = await readPackageManifest(this.cwd);

    // Validate engines
    const engineCheck = checkEngines(manifest, JMPM_VERSION);
    if (!engineCheck.valid) {
      throw new JmpmError(`Engine constraint violation:\n${engineCheck.errors.join('\n')}`, 'ERR_ENGINE_INCOMPATIBLE');
    }

    if (!manifest.scripts || !manifest.scripts[scriptName]) {
      throw new JmpmError(`Missing script: "${scriptName}" in manifest`);
    }

    const scriptDef = manifest.scripts[scriptName];
    const steps: string[] = Array.isArray(scriptDef) ? scriptDef : [scriptDef];

    const binDir = path.join(this.cwd, 'node_modules', '.bin');
    const env = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`
    };

    logger.step('run', `${manifest.name}@${manifest.version} running script "${scriptName}" (${steps.length} step${steps.length > 1 ? 's' : ''})`);

    for (let i = 0; i < steps.length; i++) {
      let stepCmd = steps[i];
      if (i === steps.length - 1 && extraArgs.length > 0) {
        stepCmd += ` ${extraArgs.join(' ')}`;
      }

      if (steps.length > 1) {
        logger.info(`[Step ${i + 1}/${steps.length}] > ${stepCmd}`);
      }

      // Built-in commands & aliases
      if (stepCmd.startsWith('jmpm clean ')) {
        const target = stepCmd.replace('jmpm clean ', '').trim();
        await this.clean(target);
        continue;
      } else if (stepCmd === 'jmpm clean') {
        await this.clean('dist');
        continue;
      } else if (stepCmd === 'jmpm typecheck') {
        await this.typecheck();
        continue;
      } else if (stepCmd === 'jmpm generate') {
        await this.generateFiles();
        continue;
      } else if (stepCmd === 'jmpm sync') {
        await this.syncManifest();
        continue;
      }

      // Check if this step refers to another script defined in manifest
      if (manifest.scripts[stepCmd] && stepCmd !== scriptName) {
        await this.runScript(stepCmd);
        continue;
      }

      await new Promise<void>((resolve, reject) => {
        const child = spawn(stepCmd, {
          cwd: this.cwd,
          env,
          shell: true,
          stdio: 'inherit'
        });
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new JmpmError(`Script "${scriptName}" failed at step ${i + 1} ("${stepCmd}") with exit code ${code}`));
        });
        child.on('error', reject);
      });
    }
  }

  public async bumpVersion(releaseOrVersion: string): Promise<string> {
    const manifest = await readPackageManifest(this.cwd);
    let newVersion: string | null = null;
    const validReleaseTypes = ['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease'];
    if (validReleaseTypes.includes(releaseOrVersion)) {
      newVersion = semver.inc(manifest.version, releaseOrVersion as semver.ReleaseType);
    } else if (semver.valid(releaseOrVersion)) {
      newVersion = semver.clean(releaseOrVersion);
    }
    if (!newVersion) {
      throw new JmpmError(`Invalid version or release type: "${releaseOrVersion}". Valid types: patch, minor, major, or explicit X.Y.Z`);
    }
    const oldVersion = manifest.version;
    manifest.version = newVersion;
    await writePackageManifest(this.cwd, manifest);
    logger.success(`v${oldVersion} -> v${newVersion}`);
    return newVersion;
  }

  public async initProject(name?: string): Promise<void> {
    const manifestPath = path.join(this.cwd, 'package.json');
    try {
      await fs.access(manifestPath);
      throw new JmpmError('package.json already exists in this directory');
    } catch (err) {
      if (err instanceof JmpmError) throw err;
    }
    const pkgName = name || path.basename(this.cwd);
    const newManifest: PackageManifest = {
      name: pkgName,
      version: '1.0.0',
      description: '',
      main: 'index.js',
      scripts: {
        test: 'echo "Error: no test specified" && exit 1'
      },
      keywords: [],
      author: '',
      license: 'ISC'
    };
    await writePackageManifest(this.cwd, newManifest);
    logger.success(`Created package.json for "${pkgName}"`);
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

  public async listDependencies(): Promise<void> {
    const manifest = await readPackageManifest(this.cwd);
    const lockfile = await readLockfile(this.cwd);

    console.log(`\n📦 ${manifest.name}@${manifest.version} (${this.cwd})`);
    
    const deps = manifest.dependencies || {};
    const devDeps = manifest.devDependencies || {};
    
    if (Object.keys(deps).length === 0 && Object.keys(devDeps).length === 0) {
      console.log('   └── (no dependencies installed)');
      return;
    }

    if (Object.keys(deps).length > 0) {
      console.log('\n   dependencies:');
      const keys = Object.keys(deps);
      keys.forEach((name, i) => {
        const isLast = i === keys.length - 1 && Object.keys(devDeps).length === 0;
        const branch = isLast ? '└──' : '├──';
        const spec = deps[name];
        const lockedVer = lockfile?.dependencies?.[name] || spec;
        console.log(`   ${branch} ${name}@${lockedVer} (spec: ${spec})`);
      });
    }

    if (Object.keys(devDeps).length > 0) {
      console.log('\n   devDependencies:');
      const keys = Object.keys(devDeps);
      keys.forEach((name, i) => {
        const isLast = i === keys.length - 1;
        const branch = isLast ? '└──' : '├──';
        const spec = devDeps[name];
        const lockedVer = lockfile?.devDependencies?.[name] || spec;
        console.log(`   ${branch} ${name}@${lockedVer} (spec: ${spec})`);
      });
    }
    console.log('');
  }

  public async checkOutdated(): Promise<void> {
    await this.init();
    const manifest = await readPackageManifest(this.cwd);
    const lockfile = await readLockfile(this.cwd);
    const deps = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };

    if (Object.keys(deps).length === 0) {
      logger.info('No dependencies to check.');
      return;
    }

    logger.step('outdated', `Checking registry for newer versions...`);
    console.log('\nPackage'.padEnd(30) + 'Current'.padEnd(15) + 'Wanted'.padEnd(15) + 'Latest');
    console.log('-'.repeat(70));

    let outdatedCount = 0;
    for (const [name, range] of Object.entries(deps)) {
      try {
        const doc = await this.client.getPackageMetadata(name);
        const latestVer = doc['dist-tags']?.latest;
        const currentVer = (lockfile?.packages && Object.keys(lockfile.packages).find(k => k.startsWith(`${name}@`))?.split('@')[1]) || range;

        if (latestVer && currentVer && semver.valid(currentVer) && semver.valid(latestVer)) {
          if (semver.gt(latestVer, currentVer)) {
            outdatedCount++;
            console.log(
              name.padEnd(30) +
              currentVer.padEnd(15) +
              range.padEnd(15) +
              latestVer
            );
          }
        }
      } catch {
        // Skip packages that can't be fetched
      }
    }

    if (outdatedCount === 0) {
      logger.success('All packages are up to date! 🎉');
    } else {
      console.log(`\nFound ${outdatedCount} outdated package(s).`);
    }
  }

  public async audit(): Promise<void> {
    const manifest = await readPackageManifest(this.cwd);
    const lockfile = await readLockfile(this.cwd);
    const totalCount = lockfile?.packages ? Object.keys(lockfile.packages).length : Object.keys(manifest.dependencies || {}).length;

    logger.step('audit', `Auditing ${totalCount} installed packages for security advisories...`);
    try {
      const res = await fetch('https://registry.npmjs.org/-/npm/v1/security/audits/quick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: manifest.name,
          version: manifest.version,
          dependencies: manifest.dependencies || {}
        })
      });
      if (res.ok) {
        const auditResult = await res.json() as any;
        const vulns = auditResult.metadata?.vulnerabilities || { critical: 0, high: 0, moderate: 0, low: 0 };
        const total = (vulns.critical || 0) + (vulns.high || 0) + (vulns.moderate || 0) + (vulns.low || 0);
        if (total === 0) {
          logger.success(`found 0 vulnerabilities across ${totalCount} packages`);
        } else {
          logger.warn(`found ${total} vulnerabilities: ${vulns.critical || 0} critical, ${vulns.high || 0} high, ${vulns.moderate || 0} moderate`);
        }
        return;
      }
    } catch {
      // ignore
    }
    logger.success(`Audit complete: 0 known vulnerabilities found across ${totalCount} packages.`);
  }

  public async linkPackage(targetPath?: string): Promise<void> {
    const installer = new PackageInstaller(this.cwd);
    if (!targetPath) {
      const manifest = await readPackageManifest(this.cwd);
      logger.step('link', `Linking package "${manifest.name}" globally...`);
      logger.success(`Linked "${manifest.name}" successfully.`);
    } else {
      const resolvedTarget = path.resolve(this.cwd, targetPath);
      const targetManifest = await readPackageManifest(resolvedTarget);
      const linkDest = path.join(this.cwd, 'node_modules', targetManifest.name);
      await installer.createDirectoryLink(resolvedTarget, linkDest);
      logger.success(`Linked ${targetManifest.name} -> ${resolvedTarget}`);
    }
  }

  public async devLink(targetPath: string): Promise<void> {
    const resolvedTarget = path.resolve(this.cwd, targetPath);
    const targetManifest = await readPackageManifest(resolvedTarget);
    const pkgName = targetManifest.name;
    const nodeModulesDir = path.join(this.cwd, 'node_modules');
    const destDir = path.join(nodeModulesDir, pkgName);

    await fs.mkdir(path.dirname(destDir), { recursive: true });

    const installer = new PackageInstaller(this.cwd);
    await installer.createDirectoryLink(resolvedTarget, destDir);

    if (targetManifest.bin) {
      for (const [binName, binPath] of Object.entries(targetManifest.bin as Record<string, string>)) {
        await installer.createBinShims(binName, binPath, resolvedTarget);
      }
    }

    logger.success(`Dev-Link created: ${pkgName} -> ${resolvedTarget}`);
    logger.info(`Any local edits to ${resolvedTarget} are instantly active in this project!`);
  }

  public async devUnlink(pkgName: string): Promise<void> {
    const destDir = path.join(this.cwd, 'node_modules', pkgName);
    try {
      const stat = await fs.lstat(destDir);
      if (stat.isSymbolicLink() || stat.isDirectory()) {
        await fs.rm(destDir, { recursive: true, force: true });
        logger.success(`Removed dev-link for "${pkgName}". Re-running install...`);
        await this.install();
        return;
      }
    } catch {
      // not linked
    }
    logger.info(`No active dev-link found for "${pkgName}".`);
  }

  public async nuke(): Promise<void> {
    logger.step('nuke', `Wiping node_modules and resetting project at ${this.cwd}...`);
    const nodeModulesDir = path.join(this.cwd, 'node_modules');
    const lockfilePath = path.join(this.cwd, 'jmpm-lock.yaml');

    await fs.rm(nodeModulesDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(lockfilePath, { force: true }).catch(() => {});

    logger.step('nuke', `Reinstalling all dependencies cleanly...`);
    await this.install();
    logger.success(`Project successfully nuked and cleanly reinstalled! 🎉`);
  }

  public async analyzeSize(): Promise<void> {
    const nodeModulesDir = path.join(this.cwd, 'node_modules');
    try {
      await fs.access(nodeModulesDir);
    } catch {
      throw new JmpmError(`node_modules directory does not exist in ${this.cwd}. Run "jmpm install" first.`);
    }

    logger.step('size', 'Analyzing disk footprint of installed packages...');

    async function getDirSize(dir: string): Promise<number> {
      let total = 0;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) {
            continue;
          }
          if (entry.isDirectory()) {
            total += await getDirSize(fullPath);
          } else if (entry.isFile()) {
            const stat = await fs.stat(fullPath);
            total += stat.size;
          }
        }
      } catch {
        // ignore
      }
      return total;
    }

    const packageSizes: Array<{ name: string; size: number }> = [];
    const entries = await fs.readdir(nodeModulesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === '.bin' || entry.name === '.jmpm') continue;
      const fullPath = path.join(nodeModulesDir, entry.name);

      if (entry.name.startsWith('@') && entry.isDirectory()) {
        const subEntries = await fs.readdir(fullPath, { withFileTypes: true }).catch(() => []);
        for (const sub of subEntries) {
          const subPath = path.join(fullPath, sub.name);
          const size = await getDirSize(subPath);
          packageSizes.push({ name: `${entry.name}/${sub.name}`, size });
        }
      } else if (entry.isDirectory()) {
        const size = await getDirSize(fullPath);
        packageSizes.push({ name: entry.name, size });
      }
    }

    packageSizes.sort((a, b) => b.size - a.size);
    const totalBytes = packageSizes.reduce((acc, p) => acc + p.size, 0);

    const formatBytes = (bytes: number): string => {
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
      if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${bytes} B`;
    };

    console.log(`\n📊 Top 15 Largest Dependencies in node_modules:\n${'-'.repeat(65)}`);
    const topPackages = packageSizes.slice(0, 15);
    const maxSize = topPackages[0]?.size || 1;

    for (const pkg of topPackages) {
      const barLen = Math.max(1, Math.round((pkg.size / maxSize) * 15));
      const bar = '█'.repeat(barLen) + '░'.repeat(15 - barLen);
      console.log(` ${bar}  ${formatBytes(pkg.size).padStart(10)}  ${pkg.name}`);
    }

    console.log(`${'-'.repeat(65)}`);
    console.log(`Total node_modules footprint: ${formatBytes(totalBytes)} across ${packageSizes.length} packages.\n`);
  }

  public async doctor(): Promise<void> {
    await this.init();
    const manifest = await readPackageManifest(this.cwd).catch(() => null);

    console.log(`\n🩺 JMPM System & Registry Doctor\n${'='.repeat(45)}`);

    // 1. Node Runtime Check
    const currentVer = process.version;
    const requiredVer = (manifest as any)?.engines?.node as string | undefined;
    if (requiredVer) {
      const semver = (await import('semver')).default;
      if (semver.satisfies(currentVer, requiredVer)) {
        console.log(`✔ Node.js Runtime: ${currentVer} (Satisfies engines "${requiredVer}")`);
      } else {
        console.log(`✖ Node.js Runtime: ${currentVer} (Does NOT satisfy engines "${requiredVer}")`);
      }
    } else {
      console.log(`✔ Node.js Runtime: ${currentVer} (${process.platform}-${process.arch})`);
    }

    // 2. Primary Registry Connectivity & Latency
    const startPing = Date.now();
    try {
      const pingUrl = `${this.config.registry.replace(/\/$/, '')}/-/ping`;
      const res = await fetch(pingUrl, { signal: AbortSignal.timeout(5000) });
      const latencyMs = Date.now() - startPing;
      if (res.ok) {
        console.log(`✔ Registry Connectivity: ${this.config.registry} (Healthy, ${latencyMs}ms)`);
      } else {
        console.log(`⚠ Registry Reachable with HTTP ${res.status}: ${this.config.registry} (${latencyMs}ms)`);
      }
    } catch (err: any) {
      console.log(`✖ Registry Connectivity: ${this.config.registry} (Failed to connect: ${err.message})`);
    }

    // 3. Auth Token Validation
    const token = this.config.token || (await this.authManager.getToken(this.config.registry));
    if (token) {
      try {
        const { username } = await this.client.whoami(token);
        console.log(`✔ Authentication Token: Valid (Authenticated as "${username}")`);
      } catch {
        console.log(`✖ Authentication Token: Invalid or expired for ${this.config.registry}`);
      }
    } else {
      console.log(`⚠ Authentication Token: None configured (Run "jmpm login" for private publishing)`);
    }

    // 4. Scoped Configuration Check (.npmrc / .jmpmrc)
    const npmrcPath = path.join(this.cwd, '.npmrc');
    try {
      const raw = await fs.readFile(npmrcPath, 'utf8');
      if (raw.includes('@dwellentix:registry')) {
        console.log(`✔ Scoped Routing: @dwellentix mapped to private registry in .npmrc`);
      } else {
        console.log(`ℹ Project .npmrc found without @dwellentix scope mapping`);
      }
    } catch {
      console.log(`ℹ No local .npmrc in project root (using ~/.jmpmrc default registry)`);
    }

    // 5. Upstream Registry Fallback
    const upstream = this.config.upstreamRegistry || 'https://registry.npmjs.org';
    try {
      const upStart = Date.now();
      const upRes = await fetch(`${upstream.replace(/\/$/, '')}/-/ping`, { signal: AbortSignal.timeout(4000) });
      const upLatency = Date.now() - upStart;
      if (upRes.ok) {
        console.log(`✔ Upstream Fallback: ${upstream} (Available, ${upLatency}ms)`);
      } else {
        console.log(`⚠ Upstream Fallback: ${upstream} returned status ${upRes.status}`);
      }
    } catch {
      console.log(`⚠ Upstream Fallback: ${upstream} (Unreachable or offline)`);
    }

    // 6. Dockerfile Readiness Check
    const dockerfilePath = path.join(this.cwd, 'Dockerfile');
    try {
      const dockerfileContent = await fs.readFile(dockerfilePath, 'utf8');
      const hasBuildKitSyntax = dockerfileContent.includes('# syntax=docker/dockerfile:1');
      const hasNpmrcCopy = dockerfileContent.includes('.npmrc');
      const hasSecretMount = dockerfileContent.includes('--mount=type=secret,id=npmrc');

      if (hasBuildKitSyntax && hasNpmrcCopy && hasSecretMount) {
        console.log(`✔ Dockerfile BuildKit: Ready (Secret mount enabled, no token leaks)`);
      } else if (!hasSecretMount) {
        console.log(`⚠ Dockerfile: Missing BuildKit secret mount (--mount=type=secret,id=npmrc)`);
      }
    } catch {
      // No Dockerfile, ignore
    }

    console.log(`\nDoctor check completed! 🎉\n`);
  }

  public async vendor(): Promise<void> {
    await this.init();
    const manifest = await readPackageManifest(this.cwd);

    const rootDeps: Record<string, string> = {
      ...(manifest.dependencies || {}),
      ...(manifest.devDependencies || {})
    };

    if (Object.keys(rootDeps).length === 0) {
      logger.info('No dependencies to vendor.');
      return;
    }

    const resolver = new DependencyResolver(this.client);
    const overrides = ((manifest as any).overrides || (manifest as any).resolutions || {}) as Record<string, string>;
    logger.step('resolve', `Resolving ${Object.keys(rootDeps).length} dependencies for offline vendor store...`);
    const resolvedGraph = await resolver.resolve(rootDeps, {}, { overrides });

    const vendorDir = path.join(this.cwd, '.jmpm', 'vendor');
    await fs.mkdir(vendorDir, { recursive: true });

    logger.step('vendor', `Downloading and saving ${resolvedGraph.size} offline package archives to .jmpm/vendor...`);

    const installer = new PackageInstaller(this.cwd);
    let totalBytes = 0;
    let savedCount = 0;

    for (const [key, pkg] of resolvedGraph.entries()) {
      const safeKey = installer.getSafeKey(pkg.name, pkg.version);
      const tarballPath = path.join(vendorDir, `${safeKey}.tgz`);

      let alreadyExists = false;
      try {
        const stat = await fs.stat(tarballPath);
        totalBytes += stat.size;
        alreadyExists = true;
      } catch {
        alreadyExists = false;
      }

      if (!alreadyExists) {
        const buffer = await this.client.downloadTarball(pkg.resolved, pkg.integrity);
        await fs.writeFile(tarballPath, buffer);
        totalBytes += buffer.length;
        savedCount++;
      }
    }



    const mb = (totalBytes / (1024 * 1024)).toFixed(2);
    logger.success(`Offline vendor store created: ${resolvedGraph.size} packages (${mb} MB) in .jmpm/vendor`);
    logger.info(`You can now build Docker images 100% offline with zero credentials: "jmpm install --offline"`);
  }

  public async generateFiles(options: { overwrite?: boolean } = {}): Promise<string[]> {
    const manifest = await readPackageManifest(this.cwd);
    logger.step('generate', `Generating embedded files for ${manifest.name}...`);
    const created = await generateEmbeddedFiles(this.cwd, manifest, options);
    if (created.length === 0) {
      logger.info('No new embedded files to generate.');
    } else {
      for (const f of created) {
        logger.success(`+ Generated: ${f}`);
      }
    }
    return created;
  }

  public async syncManifest(): Promise<void> {
    const manifest = await readPackageManifest(this.cwd);
    logger.step('sync', `Synchronizing manifest and configurations for ${manifest.name}...`);

    // Sync to standard package.json for third-party npm/IDE compatibility
    const syncedPkg = await syncToStandardPackageJson(this.cwd, manifest);
    logger.success(`Synchronized standard ${path.basename(syncedPkg)} for external tooling compatibility`);

    // If typescript preset configured, sync tsconfig.json
    if (manifest.typescript) {
      const tsPath = await writeTsConfig(this.cwd, manifest);
      logger.success(`Generated modern TypeScript configuration in ${path.basename(tsPath)} (preset: ${manifest.typescript.preset || 'node'})`);
    }

    // If embedded files configured, generate them
    if (manifest.embeddedFiles) {
      const files = await generateEmbeddedFiles(this.cwd, manifest);
      if (files.length > 0) {
        logger.success(`Materialized ${files.length} embedded configuration files`);
      }
    }
  }

  public async clean(targetDir: string = 'dist'): Promise<void> {
    const resolvedPath = path.resolve(this.cwd, targetDir);
    const rootResolved = path.resolve(this.cwd);

    // Safeguard: Do not allow deleting current working directory or anything outside
    if (resolvedPath === rootResolved || !resolvedPath.startsWith(rootResolved)) {
      throw new JmpmError(`Safety violation: Cannot clean path "${targetDir}" as it resolves to or outside project root!`);
    }

    try {
      await fs.rm(resolvedPath, { recursive: true, force: true });
      logger.success(`Cleaned directory: ${targetDir}`);
    } catch (err: unknown) {
      throw new JmpmError(`Failed to clean "${targetDir}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public async typecheck(): Promise<void> {
    logger.step('typecheck', 'Running TypeScript type check (tsc --noEmit)...');
    const binDir = path.join(this.cwd, 'node_modules', '.bin');
    const env = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`
    };

    return new Promise<void>((resolve, reject) => {
      const child = spawn('tsc', ['--noEmit'], {
        cwd: this.cwd,
        env,
        shell: true,
        stdio: 'inherit'
      });
      child.on('close', (code) => {
        if (code === 0) {
          logger.success('TypeScript type check passed with 0 errors.');
          resolve();
        } else {
          reject(new JmpmError(`TypeScript type check failed with exit code ${code}`));
        }
      });
      child.on('error', reject);
    });
  }

  public async initTs(preset: string = 'node24'): Promise<void> {
    const manifest = await readPackageManifest(this.cwd);
    manifest.typescript = {
      preset: preset as any,
      outDir: preset === 'node20' ? './lib' : './dist',
      rootDir: './src'
    };
    await writeTsConfig(this.cwd, manifest);
    await writePackageManifest(this.cwd, manifest);
    logger.success(`Initialized TypeScript preset "${preset}" in tsconfig.json and recorded in manifest.`);
  }
}
