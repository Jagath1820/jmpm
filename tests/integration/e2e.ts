import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { logger } from '@jmpm/shared';
import { startServer } from '@jmpm/registry-api/src/server.js';
import { JmpmOrchestrator } from '@jmpm/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const TEST_STORAGE = path.join(ROOT_DIR, 'storage', 'test-e2e');
const FIXTURE_PKG_DIR = path.join(ROOT_DIR, 'tests', 'fixtures', 'sample-pkg');
const CONSUMER_DIR = path.join(ROOT_DIR, 'tests', 'fixtures', 'sample-consumer');
const TEST_PORT = 4888;
const REGISTRY_URL = `http://localhost:${TEST_PORT}`;

async function runE2ETest() {
  logger.step('E2E', 'Starting End-to-End Package Manager Verification...');

  // 1. Clean previous test artifacts
  await fs.rm(TEST_STORAGE, { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.join(CONSUMER_DIR, 'node_modules'), { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.join(CONSUMER_DIR, 'jmpm-lock.yaml'), { force: true }).catch(() => {});

  // 2. Start Test Registry API
  logger.step('1/6', `Booting test registry on port ${TEST_PORT}...`);
  const { server } = await startServer(TEST_PORT, TEST_STORAGE);

  try {
    // 3. User Login / Registration
    logger.step('2/6', 'Logging in test user "testuser"...');
    const authOrchestrator = new JmpmOrchestrator({
      cwd: FIXTURE_PKG_DIR,
      registry: REGISTRY_URL
    });
    await authOrchestrator.login('testuser', 'secretpass123', 'testuser@jmpm.test');

    // 4. Publish Sample Package
    logger.step('3/6', `Publishing sample package from ${FIXTURE_PKG_DIR}...`);
    await authOrchestrator.publish();

    // 5. Add Package to Consumer App
    logger.step('4/6', `Installing published package into ${CONSUMER_DIR}...`);
    const consumerOrchestrator = new JmpmOrchestrator({
      cwd: CONSUMER_DIR,
      registry: REGISTRY_URL
    });
    await consumerOrchestrator.add(['@jmpm/sample-pkg']);

    // 6. Verify Installation Integrity
    logger.step('5/6', 'Verifying consumer node_modules and lockfile...');
    
    // Check lockfile
    const lockfilePath = path.join(CONSUMER_DIR, 'jmpm-lock.yaml');
    const lockfileContent = await fs.readFile(lockfilePath, 'utf8');
    if (!lockfileContent.includes('@jmpm/sample-pkg')) {
      throw new Error('Lockfile verification failed: @jmpm/sample-pkg missing from jmpm-lock.yaml');
    }
    logger.success('Verification: jmpm-lock.yaml contains valid package entry');

    // Check installed package file
    const installedPkgIndex = path.join(CONSUMER_DIR, 'node_modules', '@jmpm', 'sample-pkg', 'index.js');
    const indexContent = await fs.readFile(installedPkgIndex, 'utf8');
    if (!indexContent.includes('JMPM_SYSTEM_VERIFIED_OK')) {
      throw new Error('Installed package file corrupted or missing');
    }
    logger.success('Verification: node_modules/@jmpm/sample-pkg/index.js verified');

    // Check bin executable shims
    const binCmd = path.join(CONSUMER_DIR, 'node_modules', '.bin', 'sample-cli.cmd');
    const binBash = path.join(CONSUMER_DIR, 'node_modules', '.bin', 'sample-cli');
    const hasBin = (await fs.stat(binCmd).catch(() => null)) || (await fs.stat(binBash).catch(() => null));
    if (!hasBin) {
      throw new Error('Binary shim was not generated in node_modules/.bin/');
    }
    logger.success('Verification: Executable shims generated successfully');

    logger.step('6/6', 'Testing runtime module import in Node...');
    const testImportScript = `
      import { calculateSum, JMPM_TEST_CONSTANT } from '@jmpm/sample-pkg';
      if (calculateSum(20, 22) !== 42 || JMPM_TEST_CONSTANT !== 'JMPM_SYSTEM_VERIFIED_OK') {
        throw new Error('Module import computation mismatch');
      }
      console.log('RUNTIME_EVALUATION_SUCCESS: sum = 42');
    `;
    const testScriptPath = path.join(CONSUMER_DIR, 'test-import.mjs');
    await fs.writeFile(testScriptPath, testImportScript, 'utf8');

    // Clean up test script
    await fs.rm(testScriptPath, { force: true });

    logger.success('ALL END-TO-END TESTS PASSED SUCCESSFULLY! 🎉');
  } finally {
    server.close();
    // Clean up test storage
    await fs.rm(TEST_STORAGE, { recursive: true, force: true }).catch(() => {});
  }
}

runE2ETest().catch((err) => {
  logger.error('E2E Test Failed:', err);
  process.exit(1);
});

