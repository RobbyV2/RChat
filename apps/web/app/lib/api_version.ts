// This client is built for API v1. It calls `/api/v1/...` on an instance whose discovery document
// lists `v1` in `api_versions`; instances from before API versions leave the field out and are
// called on `/api/...`. The document is fetched on the unversioned path, which every version serves.

import type { InstanceInfo } from './types'

export type ApiPrefix = 'v1' | 'unversioned'

export const prefixOf = (info: Pick<InstanceInfo, 'api_versions'> | null): ApiPrefix => {
  const versions: unknown = info?.api_versions
  return Array.isArray(versions) && versions.includes('v1') ? 'v1' : 'unversioned'
}

// The API root (`.../api`) of a base that may name a version.
export const apiRoot = (base: string) => base.replace(/\/+$/, '').replace(/\/v\d+$/, '')

export const versionedBase = (root: string, prefix: ApiPrefix) =>
  prefix === 'v1' ? `${root}/v1` : root

// A URL that ends in `/api/<x>` or `/api/v<n>/<x>` (the gateway, the health check) for `prefix`.
export const versionedUrl = (url: string, prefix: ApiPrefix) =>
  url.replace(/\/api(?:\/v\d+)?(\/[^/]+)$/, prefix === 'v1' ? '/api/v1$1' : '/api$1')

// The part of a documented path after its prefix (`/api/v1` or `/api`), or null for any other path.
export const apiTail = (path: string) => /^\/api(?:\/v1(?=\/|$))?(\/.+)?$/.exec(path)?.[1] ?? null
