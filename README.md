# jmpm (Jagath Modern Package Manager) / forgepm

> A high-performance, modular package manager and npm-compatible registry ecosystem built from scratch with TypeScript and Node.js.

## Architecture

```
jmpm/
├── apps/
│   ├── cli/                    # jmpm / forgepm CLI binary
│   ├── registry-api/           # npm-compatible CouchDB/REST registry API
│   └── registry-web/           # package search and discovery web app
│
├── packages/
│   ├── core/                   # orchestration for install/add/publish/pack
│   ├── resolver/               # semver resolution & dependency DAG
│   ├── registry-client/        # npm metadata and tarball client
│   ├── package-manifest/       # package.json validation and normalization
│   ├── lockfile/               # jmpm-lock.yaml read/write
│   ├── installer/              # virtual-store linking & safe tarball extractor
│   ├── cache/                  # content-addressed store (CAS)
│   ├── pack/                   # npm-compatible .tgz packager
│   ├── auth/                   # CLI authentication and token management
│   ├── config/                 # .jmpmrc and environment configuration
│   └── shared/                 # common types, errors, logger
│
├── services/
│   ├── metadata/               # npm abbreviated manifest & version metadata
│   └── storage/                # local disk and S3 storage adapters
│
├── prisma/
│   └── schema.prisma           # registry models (users, packages, versions)
└── tests/
    ├── fixtures/               # test packages and consumers
    └── integration/            # end-to-end integration tests
```

## Features

- **Fast & Deterministic**: Directed Acyclic Graph (DAG) dependency solver with reproducible `jmpm-lock.yaml`.
- **Content-Addressed Storage (CAS)**: Never downloads the same tarball or extracts the same files twice.
- **Isolated Virtual-Store**: Modern symlinked `node_modules` layout (pnpm-style) that prevents phantom dependencies.
- **npm-Compatible Registry API**: CouchDB-compliant endpoints supporting publishing, authentication, and installation via standard `npm` or `jmpm`.
- **Binary Shim Generation**: Automatic executable shims in `node_modules/.bin/` for both Unix and Windows (`.cmd` / bash wrappers).

## Quickstart

```bash
# Install dependencies
npm install

# Start local registry
npm run dev:registry

# Test the CLI
npx tsx apps/cli/src/bin.ts --help
```

