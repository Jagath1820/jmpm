import semver from 'semver';
import {
  RegistryPackageDocument,
  RegistryVersionMetadata,
  DistTags
} from '@jmpm/shared';

export interface AbbreviatedVersion {
  name: string;
  version: string;
  bin?: Record<string, string>;
  dist: {
    tarball: string;
    shasum: string;
    integrity?: string;
  };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface AbbreviatedManifest {
  name: string;
  'dist-tags': DistTags;
  modified: string;
  versions: Record<string, AbbreviatedVersion>;
}

export function toAbbreviatedManifest(doc: RegistryPackageDocument): AbbreviatedManifest {
  const versions: Record<string, AbbreviatedVersion> = {};

  for (const [v, meta] of Object.entries(doc.versions)) {
    let bin: Record<string, string> | undefined;
    if (typeof meta.bin === 'string') {
      const binName = meta.name.startsWith('@') ? meta.name.split('/')[1] : meta.name;
      bin = { [binName]: meta.bin };
    } else if (typeof meta.bin === 'object' && meta.bin !== null) {
      bin = meta.bin as Record<string, string>;
    }

    versions[v] = {
      name: meta.name,
      version: meta.version,
      bin,
      dist: {
        tarball: meta.dist.tarball,
        shasum: meta.dist.shasum,
        integrity: meta.dist.integrity
      },
      dependencies: meta.dependencies,
      peerDependencies: meta.peerDependencies
    };
  }

  return {
    name: doc.name,
    'dist-tags': doc['dist-tags'],
    modified: new Date().toISOString(),
    versions
  };
}

export function computeDistTags(
  currentTags: DistTags,
  newVersion: string
): DistTags {
  const tags: DistTags = { ...currentTags };
  const currentLatest = tags.latest;

  if (!currentLatest || semver.gt(newVersion, currentLatest)) {
    tags.latest = newVersion;
  }

  return tags;
}

