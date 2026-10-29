import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { JmpmConfig } from '@jmpm/shared';

export interface LoadConfigOptions {
  cwd?: string;
  cliFlags?: Partial<JmpmConfig>;
}

export function parseIni(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
      continue;
    }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }
  return result;
}

export function loadConfig(options: LoadConfigOptions = {}): JmpmConfig {
  const cwd = options.cwd || process.cwd();
  const homeDir = os.homedir();
  const userRcPath = path.join(homeDir, '.jmpmrc');
  const projectRcPath = path.join(cwd, '.jmpmrc');

  const fileConfig: Record<string, string> = {};

  if (fs.existsSync(userRcPath)) {
    try {
      Object.assign(fileConfig, parseIni(fs.readFileSync(userRcPath, 'utf8')));
    } catch {
      // ignore
    }
  }

  if (fs.existsSync(projectRcPath)) {
    try {
      Object.assign(fileConfig, parseIni(fs.readFileSync(projectRcPath, 'utf8')));
    } catch {
      // ignore
    }
  }

  const defaultStoreDir = path.join(homeDir, '.jmpm', 'store');
  const defaultRegistry = process.env.JMPM_REGISTRY || fileConfig.registry || 'http://localhost:4873';

  const config: JmpmConfig = {
    registry: options.cliFlags?.registry || defaultRegistry,
    storeDir: options.cliFlags?.storeDir || fileConfig.storeDir || defaultStoreDir,
    token: options.cliFlags?.token || process.env.JMPM_TOKEN || fileConfig.token,
    userAgent: `jmpm/1.0.0 node/${process.version} ${process.platform}-${process.arch}`,
    offline: options.cliFlags?.offline ?? (process.env.JMPM_OFFLINE === 'true' || fileConfig.offline === 'true')
  };

  return config;
}

