import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { logger } from '@jmpm/shared';
import { LocalDiskStorageAdapter, createStorageAdapter, StorageAdapter } from '@jmpm/storage';
import { toAbbreviatedManifest, computeDistTags } from '@jmpm/metadata';
import { RegistryDB } from './db.js';

export function createRegistryApp(storageDir: string = './storage', customStorage?: StorageAdapter) {
  const app = express();
  const db = new RegistryDB(storageDir);
  const storageType = (process.env.STORAGE_TYPE as 'local' | 'gcs' | 's3') || 'local';
  const storage = customStorage || createStorageAdapter({
    type: storageType,
    localDir: path.join(storageDir, 'tarballs'),
    gcsBucket: process.env.GCS_BUCKET_NAME,
    gcsProjectId: process.env.GCS_PROJECT_ID,
    gcsKeyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
  });

  // Allow larger payloads for publishing tarballs (up to 50MB)
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // Helper to extract bearer token
  const getBearerToken = (req: express.Request): string | null => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      return auth.slice(7).trim();
    }
    return null;
  };

  const requireAuthForRead = process.env.REQUIRE_AUTH_FOR_READ === 'true';

  const verifyReadAuth = (req: express.Request, res: express.Response): boolean => {
    if (!requireAuthForRead) return true;
    const token = getBearerToken(req);
    if (!token || !db.getUserByToken(token)) {
      res.status(401).json({ error: 'Unauthorized: authentication token required to access private packages' });
      return false;
    }
    return true;
  };

  // Health & Ping endpoints (Public, no auth required)
  app.get(['/health', '/-/ping'], (req, res) => {
    res.json({ ok: true, status: 'healthy', pong: true, time: new Date().toISOString() });
  });

  const getParam = (val: string | string[] | undefined): string => {
    if (Array.isArray(val)) return val[0] || '';
    return val || '';
  };

  // User registration & login (CouchDB spec)
  app.put('/-/user/org.couchdb.user::username', async (req, res) => {
    const rawParams = req.params as Record<string, string>;
    const username = rawParams.username || rawParams[':username'];
    const { password, email } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Missing username or password' });
    }

    try {
      const token = await db.registerOrLoginUser(username, password, email || `${username}@jmpm.local`);
      res.status(201).json({
        ok: true,
        id: `org.couchdb.user:${username}`,
        token
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(401).json({ error: msg });
    }
  });

  // Whoami
  app.get('/-/whoami', (req, res) => {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: missing bearer token' });
    }
    const user = db.getUserByToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    res.json({ username: user.username });
  });

  // Search packages
  app.get('/-/v1/search', (req, res) => {
    if (!verifyReadAuth(req, res)) return;
    const q = (req.query.text as string) || '';
    const results = db.searchPackages(q);
    res.json({
      objects: results.map((pkg) => ({
        package: {
          name: pkg.name,
          version: pkg['dist-tags']?.latest || '0.0.0',
          description: pkg.description || '',
          date: pkg.time?.modified || new Date().toISOString()
        }
      })),
      total: results.length
    });
  });

  // Helper to normalize package name
  const extractPkgName = (raw: string | string[] | undefined): string => {
    return decodeURIComponent(getParam(raw));
  };

  // Tarball download: GET /:package/-/:tarball
  app.get(['/:package/-/:tarball', '/@:scope/:pkg/-/:tarball'], async (req, res) => {
    if (!verifyReadAuth(req, res)) return;
    const tarball = getParam(req.params.tarball);

    // Direct signed cloud URL redirect if supported (e.g. GCS)
    if (storage.getDownloadUrl) {
      const signedUrl = await storage.getDownloadUrl(tarball).catch(() => null);
      if (signedUrl) {
        return res.redirect(302, signedUrl);
      }
    }

    const buffer = await storage.get(tarball);
    if (!buffer) {
      return res.status(404).json({ error: `Tarball ${tarball} not found` });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${tarball}"`);
    res.send(buffer);
  });

  // Package metadata: GET /:package
  app.get(['/:package', '/@:scope/:pkg'], (req, res) => {
    if (!verifyReadAuth(req, res)) return;
    const pkgName = req.params.scope
      ? `@${getParam(req.params.scope)}/${getParam(req.params.pkg)}`
      : extractPkgName(req.params.package);

    const doc = db.getPackage(pkgName);
    if (!doc) {
      return res.status(404).json({ error: `Package "${pkgName}" not found` });
    }

    // Check if client requested abbreviated manifest (npm install v1)
    const accept = req.headers.accept || '';
    if (accept.includes('application/vnd.npm.install-v1+json')) {
      res.setHeader('Content-Type', 'application/vnd.npm.install-v1+json');
      return res.json(toAbbreviatedManifest(doc));
    }

    res.json(doc);
  });

  // Version metadata: GET /:package/:version
  app.get(['/:package/:version', '/@:scope/:pkg/:version'], (req, res) => {
    if (!verifyReadAuth(req, res)) return;
    const pkgName = req.params.scope
      ? `@${getParam(req.params.scope)}/${getParam(req.params.pkg)}`
      : extractPkgName(req.params.package);
    const version = getParam(req.params.version);

    const doc = db.getPackage(pkgName);
    if (!doc || !doc.versions[version]) {
      return res.status(404).json({ error: `Version "${version}" for package "${pkgName}" not found` });
    }

    res.json(doc.versions[version]);
  });

  // Publish package: PUT /:package
  app.put(['/:package', '/@:scope/:pkg'], async (req, res) => {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authentication required to publish' });
    }
    const user = db.getUserByToken(token);
    if (!user) {
      return res.status(403).json({ error: 'Invalid authentication token' });
    }

    const payload = req.body;
    const pkgName = req.params.scope
      ? `@${getParam(req.params.scope)}/${getParam(req.params.pkg)}`
      : extractPkgName(req.params.package);

    if (!payload || !payload.versions) {
      return res.status(400).json({ error: 'Invalid publish document: missing versions' });
    }

    const incomingVersions = Object.keys(payload.versions);
    if (incomingVersions.length === 0) {
      return res.status(400).json({ error: 'No versions provided' });
    }

    const versionStr = incomingVersions[0];
    const versionData = payload.versions[versionStr];

    // Handle tarball attachment
    if (payload._attachments) {
      for (const [filename, attachment] of Object.entries<any>(payload._attachments)) {
        if (attachment.data) {
          const tarballBuffer = Buffer.from(attachment.data, 'base64');
          await storage.put(filename, tarballBuffer);
        }
      }
    }

    // Merge or create document
    let existingDoc = db.getPackage(pkgName);
    if (!existingDoc) {
      existingDoc = {
        _id: pkgName,
        name: pkgName,
        description: payload.description || versionData.description || '',
        'dist-tags': {},
        versions: {},
        time: {
          created: new Date().toISOString(),
          modified: new Date().toISOString()
        },
        maintainers: [{ name: user.username, email: user.email }]
      };
    }

    // Update versions
    existingDoc.versions[versionStr] = versionData;
    existingDoc['dist-tags'] = computeDistTags(existingDoc['dist-tags'], versionStr);
    if (existingDoc.time) {
      existingDoc.time.modified = new Date().toISOString();
      existingDoc.time[versionStr] = new Date().toISOString();
    }

    await db.savePackage(existingDoc);
    logger.success(`Registry: Published ${pkgName}@${versionStr} by ${user.username}`);

    res.status(201).json({
      ok: true,
      message: `Package ${pkgName}@${versionStr} published successfully`
    });
  });

  return { app, db, storage };
}

export async function startServer(
  port: number = 4873,
  storageDir: string = './storage',
  host: string = '0.0.0.0'
) {
  const { app, db } = createRegistryApp(storageDir);
  await db.init();

  return new Promise<{ server: any; port: number }>((resolve) => {
    const server = app.listen(port, host, () => {
      logger.success(`jmpm Registry API is listening at http://${host}:${port}`);
      resolve({ server, port });
    });
  });
}

