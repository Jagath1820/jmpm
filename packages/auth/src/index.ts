import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseIni } from '@jmpm/config';

export class AuthManager {
  private rcPath: string;

  constructor(customRcPath?: string) {
    this.rcPath = customRcPath || path.join(os.homedir(), '.jmpmrc');
  }

  private normalizeRegistry(registry: string): string {
    return registry.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  public async getToken(registry: string): Promise<string | undefined> {
    const norm = this.normalizeRegistry(registry);
    try {
      const content = await fs.readFile(this.rcPath, 'utf8');
      const ini = parseIni(content);
      return ini[`//${norm}/:_authToken`] || ini.token;
    } catch {
      return undefined;
    }
  }

  public async saveToken(registry: string, token: string): Promise<void> {
    const norm = this.normalizeRegistry(registry);
    let ini: Record<string, string> = {};
    try {
      const content = await fs.readFile(this.rcPath, 'utf8');
      ini = parseIni(content);
    } catch {
      // file might not exist yet
    }

    ini[`//${norm}/:_authToken`] = token;

    const lines = Object.entries(ini).map(([k, v]) => `${k}=${v}`);
    await fs.mkdir(path.dirname(this.rcPath), { recursive: true });
    await fs.writeFile(this.rcPath, lines.join('\n') + '\n', 'utf8');
  }

  public async removeToken(registry: string): Promise<void> {
    const norm = this.normalizeRegistry(registry);
    try {
      const content = await fs.readFile(this.rcPath, 'utf8');
      const ini = parseIni(content);
      delete ini[`//${norm}/:_authToken`];
      const lines = Object.entries(ini).map(([k, v]) => `${k}=${v}`);
      await fs.writeFile(this.rcPath, lines.join('\n') + '\n', 'utf8');
    } catch {
      // ignore
    }
  }
}

