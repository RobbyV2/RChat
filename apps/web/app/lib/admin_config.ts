// The site administration page's view of the server config: where each control's value comes
// from, and how to set a control to what the config says.

import { CONTROL_KINDS } from './admin/rows.gen'
import { brandRow, linksOf, suggestionsOf } from './admin_brand'
import { PROFANITY_TARGETS } from './rules'
import type { AdminConfig, ConfigControl, ConfigLimit, SiteSettingsPatch } from './types'

// Where a control's value comes from: the config pins it, the config says the same, the config
// says something else, or the config does not set it. The server compares documents by content,
// so forms at another revision are the same; without its answer the shown values are compared.
export type Source = 'pinned' | 'same' | 'differs' | 'none'

export const sourceOf = (c: ConfigControl): Source => {
  if (c.pinned) return 'pinned'
  if (c.config === null) return 'none'
  return (c.same ?? c.config === c.value) ? 'same' : 'differs'
}

export const controlOf = (config: AdminConfig | null, key: string) =>
  config?.controls.find(c => c.key === key) ?? null

// How the settings take a control's value, by its kind in the settings registry. The report
// forms are a document: only the config or their own editor replaces them. Brand links and
// suggestions are lists and objects; the config view shows them as JSON.
const kindOf = (key: string) => CONTROL_KINDS[key]
const isList = (key: string) => kindOf(key) === 'names' || kindOf(key) === 'servers'
const BRAND_JSON: Record<string, (shown: string) => unknown> = {
  links: linksOf,
  suggestions: suggestionsOf,
}

const list = (shown: string) =>
  shown === '' || shown === 'none'
    ? []
    : shown
        .split(',')
        .map(e => e.trim())
        .filter(Boolean)

const targets = (shown: string): SiteSettingsPatch => {
  const on = shown === 'all' ? null : list(shown)
  return {
    profanity_targets: Object.fromEntries(
      PROFANITY_TARGETS.map(t => [t.key, on === null || on.includes(t.key)])
    ),
  }
}

// The change that sets a control to `shown`, a value as the config view shows it. Null when the
// page cannot set this control.
export const patchFor = (key: string, shown: string): SiteSettingsPatch | null => {
  if (kindOf(key) === 'forms') return null
  if (key === 'profanity_targets') return targets(shown)
  const json = BRAND_JSON[kindOf(key) ?? '']
  if (json) return { [key]: json(shown) } as SiteSettingsPatch
  if (brandRow(key)) return { [key]: shown } as SiteSettingsPatch
  const value = isList(key)
    ? list(shown)
    : kindOf(key) === 'number'
      ? Number(shown)
      : shown === 'on'
        ? true
        : shown === 'off'
          ? false
          : shown
  if (typeof value === 'number' && !Number.isInteger(value)) return null
  return { [key]: value } as SiteSettingsPatch
}

// The controls "Use server config for all" changes: they differ from the config, are not
// pinned, and the page can set them.
export const differing = (config: AdminConfig | null): ConfigControl[] =>
  (config?.controls ?? []).filter(
    c => sourceOf(c) === 'differs' && patchFor(c.key, c.config ?? '') !== null
  )

// One change that sets every one of `controls` to what the config says.
export const configPatch = (controls: ConfigControl[]): SiteSettingsPatch =>
  Object.assign(
    {},
    ...controls.flatMap(c => {
      const patch = c.config === null ? null : patchFor(c.key, c.config)
      return patch ? [patch] : []
    })
  ) as SiteSettingsPatch

export const configSummary = (config: AdminConfig | null) => {
  const controls = config?.controls ?? []
  return {
    pinned: controls.filter(c => c.pinned).length,
    differs: controls.filter(c => sourceOf(c) === 'differs').length,
  }
}

// "2 pinned, 1 differs".
export const summaryLine = (config: AdminConfig | null) => {
  const { pinned, differs } = configSummary(config)
  return `${pinned} pinned, ${differs} ${differs === 1 ? 'differs' : 'differ'}`
}

export type ConfigFilter = 'all' | 'differs' | 'pinned'

export const CONFIG_FILTERS: { value: ConfigFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'differs', label: 'Differs from config' },
  { value: 'pinned', label: 'Pinned' },
]

export const filterControls = (controls: ConfigControl[], filter: ConfigFilter) =>
  controls.filter(c => filter === 'all' || sourceOf(c) === filter)

// A value as people read it: a choice by its label, a switch as On or Off, an empty list as
// "none".
export const shownValue = (shown: string, options: { value: string; label: string }[] = []) => {
  const option = options.find(o => o.value === shown)
  if (option) return option.label
  if (shown === 'on') return 'On'
  if (shown === 'off') return 'Off'
  return shown === '' ? 'none' : shown
}

// The longest file expiry in days as the config view shows it; 0 means no limit.
const capDays = (shown: string) => {
  const days = Number(shown)
  return Number.isInteger(days) && days >= 0 ? days : null
}

// Whether going from the cap `from` to the cap `to` shortens how long servers may keep files.
export const lowersCap = (from: string, to: string) => {
  const [a, b] = [capDays(from), capDays(to)]
  if (a === null || b === null || b === 0) return false
  return a === 0 || b < a
}

export const CAP_WARNING =
  'A lower limit shortens how long servers keep files. Files older than it are removed.'

// The warning to show before the page changes the control `key` from `from` to `to`, as the
// config view shows values; null without one.
export const saveWarning = (key: string, from: string, to: string) =>
  key === 'upload_expiry_max_days' && lowersCap(from, to) ? CAP_WARNING : null

// The warning to show before these controls take the config's values; null without one.
export const applyWarning = (controls: ConfigControl[]) =>
  controls.some(c => c.config !== null && saveWarning(c.key, c.value, c.config) !== null)
    ? CAP_WARNING
    : null

// A limit's value: limits without a number are unset.
export const limitValue = (l: ConfigLimit) => (l.value === null ? 'Not set' : String(l.value))

// Whether a limit is at its default.
export const limitChanged = (l: ConfigLimit) => l.value !== l.default
