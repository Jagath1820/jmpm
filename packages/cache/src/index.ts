import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ChecksumMismatchError } from '@jmpm/shared';

export class ContentAddressedCache {
  private baseDir: string;
  private tarballsDir: string;

  constructor(storeDir: string) {
    this.baseDir = storeDir;
    this.tarballsDir = path.join(storeDir, 'tarballs');
  }

  public getHashKey(integrity: string): string {
    // If standard integrity format: sha512-ABC...
    if (integrity.startsWith('sha512-')) {
      const base64 = integrity.slice(7);
      return crypto.createHash('sha256').update(base64).digest('hex');
    }
    return crypto.createHash('sha256').update(integrity).digest('hex');
  }

  public getTarballPath(integrity: string): string {
    const key = this.getHashKey(integrity);
    const prefix = key.slice(0, 2);
    return path.join(this.tarballsDir, prefix, `${key}.tgz`);
  }

  public async init(): Promise<void> {
    await fs.mkdir(this.tarballsDir, { recursive: true });
  }

  public async hasTarball(integrity: string): Promise<boolean> {
    const tarballPath = this.getTarballPath(integrity);
    try {
      await fs.access(tarballPath);
      return true;
    } catch {
      return false;
    }
  }

  public async putTarball(integrity: string, data: Buffer): Promise<string> {
    // Verify integrity before saving
    if (integrity.startsWith('sha512-')) {
      const actualSha512 = `sha512-${crypto.createHash('sha512').update(data).digest('base64')}`;
      if (actualSha512 !== integrity) {
        throw new ChecksumMismatchError('cached-tarball', integrity, actualSha512);
      }
    }

    const tarballPath = this.getTarballPath(integrity);
    await fs.mkdir(path.dirname(tarballPath), { recursive: true });
    
    // Write atomically via temporary file
    const tmpPath = `${tarballPath}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, tarballPath);

    return tarballPath;
  }

  public async getTarball(integrity: string): Promise<Buffer | null> {
    const tarballPath = this.getTarballPath(integrity);
    try {
      return await fs.readFile(tarballPath);
    } catch {
      return null;
    }
  }

  public async clean(): Promise<void> {
    try {
      await fs.rm(this.tarballsDir, { recursive: true, force: true });
      await this.init();
    } catch {
      // ignore
    }
  }
}

