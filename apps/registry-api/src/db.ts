import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { RegistryPackageDocument, DistTags } from '@jmpm/shared';
import { StorageAdapter } from '@jmpm/storage';

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  email: string;
  token: string;
  createdAt: string;
}

export interface RegistryDatabaseData {
  users: Record<string, UserRecord>; // username -> user
  tokens: Record<string, string>; // token -> username
  packages: Record<string, RegistryPackageDocument>; // package_name -> document
}

export class RegistryDB {
  private dbFilePath: string;
  private storage?: StorageAdapter;
  private data: RegistryDatabaseData = {
    users: {},
    tokens: {},
    packages: {}
  };

  constructor(storageDir: string = './storage', storage?: StorageAdapter) {
    this.dbFilePath = path.resolve(storageDir, 'registry-db.json');
    this.storage = storage;
  }

  public async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.dbFilePath), { recursive: true });

    // If a persistent cloud storage adapter is provided (e.g. GCS/S3), restore metadata from it
    if (this.storage) {
      try {
        const remoteBuffer = await this.storage.get('registry-db.json');
        if (remoteBuffer && remoteBuffer.length > 0) {
          this.data = JSON.parse(remoteBuffer.toString('utf8'));
          await fs.writeFile(this.dbFilePath, remoteBuffer).catch(() => {});
          return;
        }
      } catch {
        // Fall back to local file
      }
    }

    try {
      const raw = await fs.readFile(this.dbFilePath, 'utf8');
      this.data = JSON.parse(raw);
    } catch {
      // Create initial DB with a default admin user
      const defaultToken = 'jmpm_sec_' + crypto.randomBytes(24).toString('hex');
      const adminUser: UserRecord = {
        id: crypto.randomUUID(),
        username: 'admin',
        passwordHash: this.hashPassword('admin'),
        email: 'admin@jmpm.local',
        token: defaultToken,
        createdAt: new Date().toISOString()
      };
      this.data.users['admin'] = adminUser;
      this.data.tokens[defaultToken] = 'admin';
      await this.save();
    }
  }

  private async save(): Promise<void> {
    const raw = JSON.stringify(this.data, null, 2);
    await fs.writeFile(this.dbFilePath, raw, 'utf8');

    // Also persist to cloud storage adapter (GCS/S3) if configured
    if (this.storage) {
      try {
        await this.storage.put('registry-db.json', Buffer.from(raw, 'utf8'));
      } catch {
        // Log or silently handle transient cloud save errors
      }
    }
  }

  public hashPassword(pwd: string): string {
    return crypto.createHash('sha256').update(pwd).digest('hex');
  }

  public async registerOrLoginUser(username: string, password: string, email: string): Promise<string> {
    let user = this.data.users[username];
    if (!user) {
      const token = 'jmpm_tok_' + crypto.randomBytes(24).toString('hex');
      user = {
        id: crypto.randomUUID(),
        username,
        passwordHash: this.hashPassword(password),
        email,
        token,
        createdAt: new Date().toISOString()
      };
      this.data.users[username] = user;
      this.data.tokens[token] = username;
      await this.save();
      return token;
    }

    // Verify password
    if (user.passwordHash !== this.hashPassword(password)) {
      throw new Error('Invalid credentials');
    }

    return user.token;
  }

  public getUserByToken(token: string): UserRecord | null {
    const username = this.data.tokens[token];
    if (!username) return null;
    return this.data.users[username] || null;
  }

  public getPackage(name: string): RegistryPackageDocument | null {
    return this.data.packages[name] || null;
  }

  public async savePackage(doc: RegistryPackageDocument): Promise<void> {
    this.data.packages[doc.name] = doc;
    await this.save();
  }

  public searchPackages(query: string): RegistryPackageDocument[] {
    const q = query.toLowerCase();
    return Object.values(this.data.packages).filter((pkg) => {
      return (
        pkg.name.toLowerCase().includes(q) ||
        (pkg.description && pkg.description.toLowerCase().includes(q))
      );
    });
  }

  public getAllPackages(): RegistryPackageDocument[] {
    return Object.values(this.data.packages);
  }

  public async deletePackage(name: string): Promise<boolean> {
    if (this.data.packages[name]) {
      delete this.data.packages[name];
      await this.save();
      return true;
    }
    return false;
  }

  public async deleteVersion(name: string, version: string): Promise<boolean> {
    const pkg = this.data.packages[name];
    if (pkg && pkg.versions[version]) {
      delete pkg.versions[version];
      const remainingVersions = Object.keys(pkg.versions);
      if (remainingVersions.length === 0) {
        delete this.data.packages[name];
      } else if (pkg['dist-tags']?.latest === version) {
        pkg['dist-tags'].latest = remainingVersions[remainingVersions.length - 1];
      }
      await this.save();
      return true;
    }
    return false;
  }

  public async deprecateVersion(name: string, version: string, message: string): Promise<boolean> {
    const pkg = this.data.packages[name];
    if (pkg && pkg.versions[version]) {
      (pkg.versions[version] as any).deprecated = message;
      await this.save();
      return true;
    }
    return false;
  }
}

