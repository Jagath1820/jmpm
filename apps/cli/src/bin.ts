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
  .option('--offline', 'Install from local .jmpm/vendor store without network')
  .option('-t, --target <profile>', 'Install dependencies for a specific target profile (e.g. docker, local)')
  .action(async (cmdOpts: { offline?: boolean; target?: string }) => {
    const opts = program.opts();
    const orchestrator = new JmpmOrchestrator({
      registry: opts.registry,
      token: opts.token
    });
    await orchestrator.install({ offline: cmdOpts.offline, target: cmdOpts.target });
  });

// vendor
program
  .command('vendor')
  .description('Download and package all dependencies into local .jmpm/vendor for offline Docker builds')
  .action(async () => {
    const opts = program.opts();
    const orchestrator = new JmpmOrchestrator({
      registry: opts.registry,
      token: opts.token
    });
    await orchestrator.vendor();
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
  .option('-t, --tag <tag>', 'Tag for the published package', 'latest')
  .action(async (cmdOpts: { tag?: string }) => {
    const opts = program.opts();
    const orchestrator = new JmpmOrchestrator({
      registry: opts.registry,
      token: opts.token
    });
    await orchestrator.publish({ tag: cmdOpts.tag });
  });

// run script
program
  .command('run <script> [args...]')
  .description('Run an arbitrary package script')
  .allowUnknownOption()
  .action(async (script: string, args: string[]) => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.runScript(script, args);
  });

// start (shortcut for run start)
program
  .command('start [args...]')
  .description('Run the "start" script defined in package.json')
  .allowUnknownOption()
  .action(async (args: string[]) => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.runScript('start', args);
  });

// test (shortcut for run test)
program
  .command('test [args...]')
  .description('Run the "test" script defined in package.json')
  .allowUnknownOption()
  .action(async (args: string[]) => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.runScript('test', args);
  });

// version
program
  .command('version <newversion>')
  .description('Bump package version (patch, minor, major, prerelease, or X.Y.Z)')
  .action(async (newversion: string) => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.bumpVersion(newversion);
  });

// init
program
  .command('init [name]')
  .description('Initialize a new package.json')
  .action(async (name?: string) => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.initProject(name);
  });

// list / ls
program
  .command('list')
  .alias('ls')
  .description('List installed package dependencies')
  .action(async () => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.listDependencies();
  });

// outdated
program
  .command('outdated')
  .description('Check for outdated dependencies against the registry')
  .action(async () => {
    const opts = program.opts();
    const orchestrator = new JmpmOrchestrator({
      registry: opts.registry,
      token: opts.token
    });
    await orchestrator.checkOutdated();
  });

// audit
program
  .command('audit')
  .description('Audit installed packages for security vulnerabilities')
  .action(async () => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.audit();
  });

// link
program
  .command('link [target]')
  .description('Symlink a local package into node_modules')
  .action(async (target?: string) => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.linkPackage(target);
  });

// dev-link
program
  .command('dev-link <target>')
  .description('Live-link a local dependency into node_modules for rapid local development')
  .action(async (target: string) => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.devLink(target);
  });

// dev-unlink
program
  .command('dev-unlink <package>')
  .description('Remove a local dev-link and restore clean installation')
  .action(async (pkg: string) => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.devUnlink(pkg);
  });

// doctor
program
  .command('doctor')
  .description('Diagnose Node runtime, registry connectivity, tokens, and Docker readiness')
  .action(async () => {
    const opts = program.opts();
    const orchestrator = new JmpmOrchestrator({
      registry: opts.registry,
      token: opts.token
    });
    await orchestrator.doctor();
  });

// nuke / reset
program
  .command('nuke')
  .alias('reset')
  .description('Wipe node_modules and lockfile, then cleanly reinstall all packages')
  .action(async () => {
    const opts = program.opts();
    const orchestrator = new JmpmOrchestrator({
      registry: opts.registry,
      token: opts.token
    });
    await orchestrator.nuke();
  });

// size
program
  .command('size')
  .description('Analyze and display top disk-space-consuming dependencies')
  .action(async () => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.analyzeSize();
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

// generate
program
  .command('generate')
  .alias('gen')
  .description('Materialize embeddedFiles declared in manifest into the project')
  .option('-f, --force', 'Overwrite existing files', false)
  .action(async (cmdOpts: { force?: boolean }) => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.generateFiles({ overwrite: cmdOpts.force });
  });

// sync
program
  .command('sync')
  .description('Synchronize manifest to standard package.json and update tsconfig.json')
  .action(async () => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.syncManifest();
  });

// typecheck
program
  .command('typecheck')
  .alias('tc')
  .description('Run TypeScript type checker (tsc --noEmit)')
  .action(async () => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.typecheck();
  });

// clean
program
  .command('clean [dir]')
  .description('Safely clean output/build directory (default: dist)')
  .action(async (dir?: string) => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.clean(dir || 'dist');
  });

// init-ts
program
  .command('init-ts [preset]')
  .description('Initialize modern tsconfig.json preset (node24, node20, react, lib)')
  .action(async (preset?: string) => {
    const orchestrator = new JmpmOrchestrator();
    await orchestrator.initTs(preset || 'node24');
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

