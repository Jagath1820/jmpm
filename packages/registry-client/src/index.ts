import crypto from 'node:crypto';
import {
  RegistryPackageDocument,
  PackageNotFoundError,
  ChecksumMismatchError,
  JmpmError
} from '@jmpm/shared';
import { ContentAddressedCache } from '@jmpm/cache';

export interface RegistryClientOptions {
  registryUrl: string;
  token?: string;
  cache?: ContentAddressedCache;
  userAgent?: string;
}

export class RegistryClient {
  public registryUrl: string;
  private token?: string;
  private cache?: ContentAddressedCache;
  private userAgent: string;

  constructor(options: RegistryClientOptions) {
    this.registryUrl = options.registryUrl.replace(/\/$/, '');
    this.token = options.token;
    this.cache = options.cache;
    this.userAgent = options.userAgent || 'jmpm/1.0.0';
  }

  public setToken(token: string | undefined): void {
    this.token = token;
  }

  private getHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
      ...extraHeaders
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  public async getPackageMetadata(packageName: string): Promise<RegistryPackageDocument> {
    const encodedName = packageName.startsWith('@')
      ? `@${encodeURIComponent(packageName.slice(1))}`
      : encodeURIComponent(packageName);

    const url = `${this.registryUrl}/${encodedName}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders()
    });

    if (res.status === 404) {
      throw new PackageNotFoundError(packageName, this.registryUrl);
    }

    if (!res.ok) {
      throw new JmpmError(`Registry error: ${res.status} ${res.statusText} for ${url}`);
    }

    return (await res.json()) as RegistryPackageDocument;
  }

  public async downloadTarball(
    tarballUrl: string,
    integrity?: string
  ): Promise<Buffer> {
    // 1. Check local content-addressed cache
    if (integrity && this.cache) {
      const cached = await this.cache.getTarball(integrity);
      if (cached) {
        return cached;
      }
    }

    // 2. Fetch from registry / tarball URL
    const res = await fetch(tarballUrl, {
      method: 'GET',
      headers: this.getHeaders()
    });

    if (!res.ok) {
      throw new JmpmError(`Failed to download tarball from ${tarballUrl}: ${res.statusText}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 3. Verify integrity
    if (integrity && integrity.startsWith('sha512-')) {
      const actualHash = `sha512-${crypto.createHash('sha512').update(buffer).digest('base64')}`;
      if (actualHash !== integrity) {
        throw new ChecksumMismatchError(tarballUrl, integrity, actualHash);
      }
    }

    // 4. Save to cache
    if (integrity && this.cache) {
      await this.cache.putTarball(integrity, buffer);
    }

    return buffer;
  }

  public async publish(
    doc: Record<string, unknown>,
    token?: string
  ): Promise<{ ok: boolean; message?: string }> {
    const authToken = token || this.token;
    if (!authToken) {
      throw new JmpmError('Authentication required: please run `jmpm login` first');
    }

    const packageName = doc.name as string;
    const encodedName = packageName.startsWith('@')
      ? `@${encodeURIComponent(packageName.slice(1))}`
      : encodeURIComponent(packageName);

    const url = `${this.registryUrl}/${encodedName}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        'User-Agent': this.userAgent
      },
      body: JSON.stringify(doc)
    });

    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    if (!res.ok) {
      throw new JmpmError(`Publish failed: ${data.message || data.error || res.statusText}`);
    }

    return { ok: true, message: data.message };
  }

  public async login(
    username: string,
    password: string,
    email: string = `${username}@example.com`
  ): Promise<{ token: string }> {
    const url = `${this.registryUrl}/-/user/org.couchdb.user:${encodeURIComponent(username)}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': this.userAgent
      },
      body: JSON.stringify({
        name: username,
        password,
        email,
        type: 'user',
        roles: [],
        date: new Date().toISOString()
      })
    });

    const data = (await res.json()) as { token?: string; error?: string; message?: string };
    if (!res.ok || !data.token) {
      throw new JmpmError(`Login failed: ${data.message || data.error || res.statusText}`);
    }

    return { token: data.token };
  }

  public async whoami(token?: string): Promise<{ username: string }> {
    const authToken = token || this.token;
    if (!authToken) {
      throw new JmpmError('Not logged in: no auth token provided');
    }

    const url = `${this.registryUrl}/-/whoami`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        'User-Agent': this.userAgent
      }
    });

    if (!res.ok) {
      throw new JmpmError(`Failed to identify user: ${res.statusText}`);
    }

    return (await res.json()) as { username: string };
  }
}

