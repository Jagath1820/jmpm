import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as tar from 'tar';
import { readPackageManifest } from '@jmpm/package-manifest';
import { TarballDist } from '@jmpm/shared';

export interface PackResult {
  filename: string;
  tarballBuffer: Buffer;
  dist: TarballDist;
}

export async function shouldIncludeFile(
  filePath: string,
  relPath: string,
  allowedFiles?: string[]
): Promise<boolean> {
  const normalizedRel = relPath.replace(/\\/g, '/');

  // Ignored patterns
  if (
    normalizedRel.startsWith('node_modules/') ||
    normalizedRel === 'node_modules' ||
    normalizedRel.startsWith('.git/') ||
    normalizedRel === '.git' ||
    normalizedRel.endsWith('.log') ||
    normalizedRel === '.DS_Store' ||
    normalizedRel === '.env' ||
    normalizedRel.endsWith('.tgz')
  ) {
    return false;
  }

  // Always include these
  const base = path.basename(normalizedRel).toLowerCase();
  if (
    base === 'package.json' ||
    base.startsWith('readme') ||
    base.startsWith('license') ||
    base.startsWith('licence')
  ) {
    return true;
  }

  // If specific files whitelist exists in package.json
  if (allowedFiles && allowedFiles.length > 0) {
    return allowedFiles.some((pattern) => {
      const cleanPattern = pattern.replace(/^\.\//, '').replace(/\/$/, '');
      return (
        normalizedRel === cleanPattern ||
        normalizedRel.startsWith(cleanPattern + '/')
      );
    });
  }

  return true;
}

export async function collectFiles(
  dir: string,
  baseDir: string = dir,
  allowedFiles?: string[]
): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (
        relPath === 'node_modules' ||
        relPath === '.git' ||
        relPath === 'dist/tmp'
      ) {
        continue;
      }
      const subFiles = await collectFiles(fullPath, baseDir, allowedFiles);
      results.push(...subFiles);
    } else if (entry.isFile()) {
      if (await shouldIncludeFile(fullPath, relPath, allowedFiles)) {
        results.push(relPath);
      }
    }
  }

  return results;
}

export async function packPackage(pkgDir: string): Promise<PackResult> {
  const manifest = await readPackageManifest(pkgDir);
  const files = await collectFiles(pkgDir, pkgDir, manifest.files);

  // Clean package name for tarball filename (e.g., @scope/pkg -> scope-pkg)
  const safeName = manifest.name.replace(/^@/, '').replace(/\//, '-');
  const filename = `${safeName}-${manifest.version}.tgz`;

  // Create gzipped tarball in memory using tar.c
  const tarStream = tar.c(
    {
      gzip: true,
      cwd: pkgDir,
      prefix: 'package/'
    },
    files
  );

  const chunks: Buffer[] = [];
  for await (const chunk of tarStream) {
    chunks.push(Buffer.from(chunk));
  }

  const tarballBuffer = Buffer.concat(chunks);

  // Compute checksums
  const sha1 = crypto.createHash('sha1').update(tarballBuffer).digest('hex');
  const sha512 = crypto.createHash('sha512').update(tarballBuffer).digest('base64');
  const integrity = `sha512-${sha512}`;

  // Unpacked size estimation
  let unpackedSize = 0;
  for (const rel of files) {
    try {
      const stat = await fs.stat(path.join(pkgDir, rel));
      unpackedSize += stat.size;
    } catch {
      // ignore
    }
  }

  return {
    filename,
    tarballBuffer,
    dist: {
      tarball: filename,
      shasum: sha1,
      integrity,
      unpackedSize,
      fileCount: files.length
    }
  };
}

