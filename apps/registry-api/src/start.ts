import { logger } from '@jmpm/shared';
import { startServer } from './server.js';

const port = parseInt(process.env.PORT || '4873', 10);
const host = process.env.HOST || '0.0.0.0';
const storageDir = process.env.STORAGE_LOCAL_DIR || './storage';

logger.info(`Starting jmpm registry on ${host}:${port}...`);

startServer(port, storageDir, host).catch((err) => {
  logger.error('Failed to start registry server:', err);
  process.exit(1);
});
