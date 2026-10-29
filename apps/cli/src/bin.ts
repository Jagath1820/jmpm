#!/usr/bin/env node
import { Command } from 'commander';
import readline from 'node:readline/promises';
import { logger, JmpmError } from '@jmpm/shared';
import { JmpmOrchestrator } from '@jmpm/core';

const program = new Command();

program
  .name('jmpm')
  .description('jmpm (and forgepm) - Modern TypeScript Package Manager & Registry Client')
  .version('1.0.0')
  .option('-r, --registry <url>', 'Override registry URL')
  .option('--token <token>', 'Registry auth token');

// install
program
  .command('install')
  .alias('i')
  .description('Install dependencies from package.json and jmpm-lock.yaml')
  .action(async () => {
    const opts = program.opts();
    const orchestrator = new JmpmOrchestrator({
      registry: opts.registry,
      token: opts.token
    });
    await orchestrator.install();
  });

// add
program
  .command('add <packages...>')
  .description('Add one or more dependencies and install them')
  .option('-D, --save-dev', 'Save package to devDependencies', false)
  .action(async (packages: string[], cmdOpts: { saveDev: boolean }) => {
    const opts = program.opts();
    const orchestrator = new JmpmOrchestrator({
      registry: opts.registry,
      token: opts.token
    });
    await orchestrator.add(packages, cmdOpts.saveDev);
  });

// remove
program
  .command('remove <packages...>')
  .alias('rm')
  .description('Remove one or more dependencies')
  .action(async (packages: string[]) => {
    const opts = program.opts();
    const orchestrator = new JmpmOrchestrator({
      registry: opts.registry,
      token: opts.token
    });
    await orchestrator.remove(packages);
  });

// pack
program
  .command('pack')
  .description('Create an npm-compatible .tgz tarball archive')
  .action(async () => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.pack();
  });

// publish
program
  .command('publish')
  .description('Publish a package to the registry')
  .action(async () => {
    const opts = program.opts();
    const orchestrator = new JmpmOrchestrator({
      registry: opts.registry,
      token: opts.token
    });
    await orchestrator.publish();
  });

// login
program
  .command('login')
  .description('Authenticate with the registry')
  .option('-u, --username <username>', 'Username')
  .option('-p, --password <password>', 'Password')
  .option('-e, --email <email>', 'Email')
  .action(async (cmdOpts) => {
    const opts = program.opts();
    const orchestrator = new JmpmOrchestrator({
      registry: opts.registry,
      token: opts.token
    });

    let username = cmdOpts.username;
    let password = cmdOpts.password;
    let email = cmdOpts.email;

    if (!username || !password) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      try {
        if (!username) username = await rl.question('Username: ');
        if (!password) password = await rl.question('Password: ');
        if (!email) email = (await rl.question('Email (optional): ')) || `${username}@jmpm.local`;
      } finally {
        rl.close();
      }
    }

    await orchestrator.login(username, password, email);
  });

// whoami
program
  .command('whoami')
  .description('Show current authenticated user')
  .action(async () => {
    const opts = program.opts();
    const orchestrator = new JmpmOrchestrator({
      registry: opts.registry,
      token: opts.token
    });
    await orchestrator.whoami();
  });

// cache clean
const cacheCmd = program.command('cache').description('Manage the package cache');
cacheCmd
  .command('clean')
  .description('Clean all cached tarballs from the local content-addressed store')
  .action(async () => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.cleanCache();
  });

// Global error handler
async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err: unknown) {
    if (err instanceof JmpmError) {
      logger.error(`[${(err as JmpmError).code}] ${(err as Error).message}`);
    } else if (err instanceof Error) {
      logger.error(err.message);
    } else {
      logger.error(String(err));
    }
    process.exit(1);
  }
}

main();

