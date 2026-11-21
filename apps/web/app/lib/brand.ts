// The brand an instance sends: read defensively, so a missing or odd part reads as unset.

import type { Brand, BrandAsset, BrandLink, InstanceSuggestion } from './types'

const ASSETS: BrandAsset[] = [
  'logo',
  'mark-32',
  'mark-180',
  'mark-192',
  'mark-512',
  'mark-maskable',
]

const text = (value: unknown) => (typeof value === 'string' ? value : '')

const links = (value: unknown): BrandLink[] =>
  Array.isArray(value)
    ? value.flatMap(l => {
        const { label, url } = (l ?? {}) as Partial<BrandLink>
        return typeof label === 'string' && typeof url === 'string' && /^https:\/\//i.test(url)
          ? [{ label, url }]
          : []
      })
    : []

const suggestions = (value: unknown): InstanceSuggestion[] =>
  Array.isArray(value)
    ? value.flatMap(s => {
        const { url, label } = (s ?? {}) as Partial<InstanceSuggestion>
        return typeof url === 'string' && /^https?:\/\//i.test(url)
          ? [{ url, label: text(label) }]
          : []
      })
    : []

// A path of an image on the instance: `/brand/<kind>.png` with its version, nothing else.
const assetPath = (kind: BrandAsset, value: unknown) =>
  typeof value === 'string' && new RegExp(`^/brand/${kind}\\.png\\?v=[0-9a-f]{1,64}$`).test(value)
    ? value
    : null

// The brand in what an instance sent, or null when it sent none (an older instance, or
// something that is no brand).
export const brandOf = (raw: unknown): Brand | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const sent = raw as Record<string, unknown>
  const instance = text(sent.instance_name).trim()
  if (instance === '') return null
  const app = text(sent.app_name).trim() || instance
  const listed = (sent.suggestions ?? {}) as { mode?: unknown; list?: unknown }
  const images = (sent.assets ?? {}) as Record<string, unknown>
  return {
    instance_name: instance,
    app_name: app,
    short_name: text(sent.short_name).trim() || app,
    about: text(sent.about),
    links: links(sent.links),
    login_note: text(sent.login_note),
    suggestions: {
      mode: listed.mode === 'replace' ? 'replace' : 'add',
      list: suggestions(listed.list),
    },
    assets: Object.fromEntries(
      ASSETS.flatMap(kind => {
        const path = assetPath(kind, images[kind])
        return path === null ? [] : [[kind, path]]
      })
    ),
  }
}

// The address of a brand image: its path on the instance's own origin.
export const assetUrl = (origin: string, path: string) => `${origin.replace(/\/+$/, '')}${path}`
