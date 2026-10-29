import fs from 'node:fs/promises';
import path from 'node:path';

export interface StorageAdapter {
  put(key: string, data: Buffer): Promise<string>;
  get(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  getDownloadUrl?(key: string): Promise<string | null>;
}

export class LocalDiskStorageAdapter implements StorageAdapter {
  private baseDir: string;

  constructor(baseDir: string = './storage/tarballs') {
    this.baseDir = path.resolve(baseDir);
  }

  private getFilePath(key: string): string {
    // Sanitize key to prevent path traversal
    const safeKey = key.replace(/[/\\?%*:|"<>]/g, '_');
    return path.join(this.baseDir, safeKey);
  }

  public async put(key: string, data: Buffer): Promise<string> {
    const filePath = this.getFilePath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
    return filePath;
  }

  public async get(key: string): Promise<Buffer | null> {
    const filePath = this.getFilePath(key);
    try {
      return await fs.readFile(filePath);
    } catch {
      return null;
    }
  }

  public async exists(key: string): Promise<boolean> {
    const filePath = this.getFilePath(key);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  public async delete(key: string): Promise<void> {
    const filePath = this.getFilePath(key);
    await fs.rm(filePath, { force: true }).catch(() => {});
  }
}

export interface GCSStorageConfig {
  bucketName: string;
  projectId?: string;
  keyFilename?: string;
}

export class GoogleCloudStorageAdapter implements StorageAdapter {
  private bucketName: string;
  private projectId?: string;
  private keyFilename?: string;
  private storageClient: any = null;

  constructor(config: GCSStorageConfig) {
    this.bucketName = config.bucketName;
    this.projectId = config.projectId;
    this.keyFilename = config.keyFilename;
  }

  private async getStorage(): Promise<any> {
    if (!this.storageClient) {
      try {
        // Dynamic import so @google-cloud/storage is only required when GCS is enabled
        const { Storage } = await import('@google-cloud/storage');
        this.storageClient = new Storage({
          projectId: this.projectId,
          keyFilename: this.keyFilename
        });
      } catch (err) {
        throw new Error(
          'Please install @google-cloud/storage to use Google Cloud Storage: npm i @google-cloud/storage'
        );
      }
    }
    return this.storageClient;
  }

  public async put(key: string, data: Buffer): Promise<string> {
    const storage = await this.getStorage();
    const file = storage.bucket(this.bucketName).file(key);
    await file.save(data, {
      contentType: 'application/octet-stream',
      resumable: false
    });
    return `gs://${this.bucketName}/${key}`;
  }

  public async get(key: string): Promise<Buffer | null> {
    const storage = await this.getStorage();
    const file = storage.bucket(this.bucketName).file(key);
    try {
      const [buffer] = await file.download();
      return buffer;
    } catch (err: any) {
      if (err.code === 404) return null;
      throw err;
    }
  }

  public async exists(key: string): Promise<boolean> {
    const storage = await this.getStorage();
    const file = storage.bucket(this.bucketName).file(key);
    try {
      const [exists] = await file.exists();
      return exists;
    } catch {
      return false;
    }
  }

  public async delete(key: string): Promise<void> {
    const storage = await this.getStorage();
    const file = storage.bucket(this.bucketName).file(key);
    await file.delete({ ignoreNotFound: true }).catch(() => {});
  }

  public async getDownloadUrl(key: string, expiresInMinutes: number = 15): Promise<string | null> {
    const storage = await this.getStorage();
    const file = storage.bucket(this.bucketName).file(key);
    try {
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + expiresInMinutes * 60 * 1000
      });
      return url;
    } catch {
      return null;
    }
  }
}

export function createStorageAdapter(config: {
  type?: 'local' | 'gcs' | 's3';
  localDir?: string;
  gcsBucket?: string;
  gcsProjectId?: string;
  gcsKeyFilename?: string;
}): StorageAdapter {
  if (config.type === 'gcs') {
    if (!config.gcsBucket) {
      throw new Error('GCS_BUCKET_NAME must be defined when STORAGE_TYPE=gcs');
    }
    return new GoogleCloudStorageAdapter({
      bucketName: config.gcsBucket,
      projectId: config.gcsProjectId,
      keyFilename: config.gcsKeyFilename
    });
  }

  return new LocalDiskStorageAdapter(config.localDir);
}
