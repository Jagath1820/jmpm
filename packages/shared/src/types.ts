export interface PackageManifest {
  name: string;
  version: string;
  description?: string;
  main?: string;
  module?: string;
  types?: string;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
  license?: string;
  repository?: string | { type: string; url: string };
  keywords?: string[];
  author?: string | { name: string; email?: string; url?: string };
  readme?: string;
  [key: string]: unknown;
}

export interface DistTags {
  latest?: string;
  [tag: string]: string | undefined;
}

export interface TarballDist {
  tarball: string;
  shasum: string;
  integrity?: string;
  unpackedSize?: number;
  fileCount?: number;
}

export interface RegistryVersionMetadata extends PackageManifest {
  _id: string;
  dist: TarballDist;
  readmeFilename?: string;
}

export interface RegistryPackageDocument {
  _id: string;
  name: string;
  description?: string;
  'dist-tags': DistTags;
  versions: Record<string, RegistryVersionMetadata>;
  time?: Record<string, string>;
  readme?: string;
  maintainers?: Array<{ name: string; email: string }>;
}

export interface ResolvedPackage {
  name: string;
  version: string;
  resolved: string; // tarball url
  integrity: string; // sha512 integrity string
  dependencies: Record<string, string>; // name -> version
  bin?: Record<string, string>;
}

export interface LockfilePackage {
  version: string;
  resolved: string;
  integrity: string;
  dependencies?: Record<string, string>;
  bin?: Record<string, string>;
}

export interface Lockfile {
  lockfileVersion: number;
  name?: string;
  dependencies?: Record<string, string>; // direct root deps: name -> spec
  devDependencies?: Record<string, string>;
  packages: Record<string, LockfilePackage>; // key: "name@version"
}

export interface InstallOptions {
  cwd?: string;
  registry?: string;
  production?: boolean;
  frozenLockfile?: boolean;
  preferOffline?: boolean;
  force?: boolean;
  silent?: boolean;
}

export interface JmpmConfig {
  registry: string;
  storeDir: string;
  token?: string;
  userAgent: string;
  offline: boolean;
}

