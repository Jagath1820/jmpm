import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import {
  ResolvedPackage,
  SecurityError,
  logger
} from '@jmpm/shared';
import { RegistryClient } from '@jmpm/registry-client';
import { ContentAddressedCache } from '@jmpm/cache';

export interface InstallPackagesOptions {
  projectDir: string;
  packages: Map<string, ResolvedPackage>;
  directDependencies: Record<string, string>;
  directDevDependencies?: Record<string, string>;
  client: RegistryClient;
  cache: ContentAddressedCache;
}

export class PackageInstaller {
  private projectDir: string;
  private nodeModulesDir: string;
  private virtualStoreDir: string;
  private binDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.nodeModulesDir = path.join(projectDir, 'node_modules');
    this.virtualStoreDir = path.join(this.nodeModulesDir, '.jmpm', 'virtual-store');
    this.binDir = path.join(this.nodeModulesDir, '.bin');
  }

  public getSafeKey(packageName: string, version: string): string {
    return `${packageName.replace(/\//g, '+')}@${version}`;
  }

  public getVirtualPackageDir(packageName: string, version: string): string {
    const safeKey = this.getSafeKey(packageName, version);
    return path.join(this.virtualStoreDir, safeKey, 'node_modules', packageName);
  }

  public async safeExtract(tarballBuffer: Buffer, destDir: string): Promise<void> {
    await fs.mkdir(destDir, { recursive: true });

    // Write temp tarball file
    const tmpTar = path.join(os.tmpdir(), `jmpm-extract-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`);
    await fs.writeFile(tmpTar, tarballBuffer);

    try {
      await tar.x({
        file: tmpTar,
        cwd: destDir,
        strip: 1, // strip 'package/' prefix
        onwarn: (code, message) => {
          if (code === 'TAR_ENTRY_INVALID') {
            throw new SecurityError(`Invalid archive entry: ${message}`);
          }
        }
      });
    } finally {
      await fs.rm(tmpTar, { force: true }).catch(() => {});
    }
  }

  public async createDirectoryLink(target: string, linkPath: string): Promise<void> {
    await fs.mkdir(path.dirname(linkPath), { recursive: true });

    // If linkPath already exists, remove it first
    try {
      const stat = await fs.lstat(linkPath);
      if (stat.isSymbolicLink() || stat.isDirectory()) {
        await fs.rm(linkPath, { recursive: true, force: true });
      }
    } catch {
      // doesn't exist, proceed
    }

    const isWindows = process.platform === 'win32';
    // Relative target path makes node_modules portable across directory moves
    const relTarget = path.relative(path.dirname(linkPath), target);

    try {
      if (isWindows) {
        // Directory junctions are unprivileged on Windows and work seamlessly
        await fs.symlink(target, linkPath, 'junction');
      } else {
        await fs.symlink(relTarget, linkPath, 'dir');
      }
    } catch (err) {
      // Fallback: directory junction or hard symlink
      try {
        await fs.symlink(target, linkPath, isWindows ? 'junction' : 'dir');
      } catch (fallbackErr) {
        // If symlink fails, copy directory as last resort
        await fs.cp(target, linkPath, { recursive: true });
      }
    }
  }

  public async createBinShims(
    binName: string,
    targetScriptRelPath: string,
    pkgInstallDir: string
  ): Promise<void> {
    await fs.mkdir(this.binDir, { recursive: true });

    const absScriptPath = path.resolve(pkgInstallDir, targetScriptRelPath);
    const relToBin = path.relative(this.binDir, absScriptPath).replace(/\\/g, '/');

    // 1. Unix bash shim
    const bashShim = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
exec node "$basedir/${relToBin}" "$@"
`;
    const bashPath = path.join(this.binDir, binName);
    await fs.writeFile(bashPath, bashShim, { mode: 0o755 });

    // 2. Windows .cmd shim
    const cmdShim = `@ECHO off
GOTO start
:start
SETLOCAL
CALL :find_dp0
"%_prog%" "%dp0%\\${relToBin.replace(/\//g, '\\')}" %*
ENDLOCAL
EXIT /b %errorlevel%
:find_dp0
SET dp0=%~dp0
SET "_prog=node"
EXIT /b 0
`;
    const cmdPath = path.join(this.binDir, `${binName}.cmd`);
    await fs.writeFile(cmdPath, cmdShim, 'utf8');

    // 3. PowerShell .ps1 shim
    const ps1Shim = `#!/usr/bin/env pwsh
$basedir = Split-Path $MyInvocation.MyCommand.Path -Parent
$exe = "node"
$target = Join-Path $basedir "${relToBin.replace(/\//g, '\\')}"
& $exe $target $args
exit $LASTEXITCODE
`;
    const ps1Path = path.join(this.binDir, `${binName}.ps1`);
    await fs.writeFile(ps1Path, ps1Shim, 'utf8');
  }

  public async install(options: InstallPackagesOptions): Promise<void> {
    await fs.mkdir(this.nodeModulesDir, { recursive: true });
    await fs.mkdir(this.virtualStoreDir, { recursive: true });

    const totalPackages = options.packages.size;
    let installedCount = 0;

    // 1. Download and extract all packages to virtual store
    for (const [key, pkg] of options.packages.entries()) {
      installedCount++;
      const targetDir = this.getVirtualPackageDir(pkg.name, pkg.version);

      // Check if already extracted
      let alreadyExtracted = false;
      try {
        await fs.access(path.join(targetDir, 'package.json'));
        alreadyExtracted = true;
      } catch {
        alreadyExtracted = false;
      }

      if (!alreadyExtracted) {
        const tarballBuffer = await options.client.downloadTarball(pkg.resolved, pkg.integrity);
        await this.safeExtract(tarballBuffer, targetDir);
      }
    }

    // 2. Link direct root dependencies into root node_modules
    const directNames = new Set([
      ...Object.keys(options.directDependencies),
      ...Object.keys(options.directDevDependencies || {})
    ]);

    for (const pkgName of directNames) {
      // Find which version was resolved for this root package
      for (const [key, pkg] of options.packages.entries()) {
        if (pkg.name === pkgName) {
          const virtualPkgDir = this.getVirtualPackageDir(pkg.name, pkg.version);
          const linkDest = path.join(this.nodeModulesDir, pkg.name);

          await this.createDirectoryLink(virtualPkgDir, linkDest);

          // Create bin shims if present
          if (pkg.bin) {
            for (const [binName, binPath] of Object.entries(pkg.bin)) {
              await this.createBinShims(binName, binPath, virtualPkgDir);
            }
          }
          break;
        }
      }
    }

    // 3. Link transitive dependencies inside virtual-store packages
    for (const [key, pkg] of options.packages.entries()) {
      if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) {
        continue;
      }

      const virtualPkgDir = this.getVirtualPackageDir(pkg.name, pkg.version);
      const pkgInternalNodeModules = path.join(path.dirname(virtualPkgDir), '..', 'node_modules');

      for (const depName of Object.keys(pkg.dependencies)) {
        // Find resolved dependency version
        for (const [otherKey, otherPkg] of options.packages.entries()) {
          if (otherPkg.name === depName) {
            const depVirtualDir = this.getVirtualPackageDir(otherPkg.name, otherPkg.version);
            const depLinkDest = path.join(pkgInternalNodeModules, depName);
            await this.createDirectoryLink(depVirtualDir, depLinkDest);
            break;
          }
        }
      }
    }
  }
}

