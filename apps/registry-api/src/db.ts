import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { RegistryPackageDocument, DistTags } from '@jmpm/shared';

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
  private data: RegistryDatabaseData = {
    users: {},
    tokens: {},
    packages: {}
  };

  constructor(storageDir: string = './storage') {
    this.dbFilePath = path.resolve(storageDir, 'registry-db.json');
  }

  public async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.dbFilePath), { recursive: true });
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
    await fs.writeFile(this.dbFilePath, JSON.stringify(this.data, null, 2), 'utf8');
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
}

