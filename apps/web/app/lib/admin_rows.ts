// The rows of the site administration page's Features section: every control the page changes,
// with the name of its setting in the server config. The rows come from the settings registry.

import { ADMIN_GROUPS, ADMIN_ROWS } from './admin/rows.gen'
import type { SearchRow } from './settings_search'
import type { SiteSettings } from './types'

export { ADMIN_GROUPS, ADMIN_ROWS }

export type AdminGroup = (typeof ADMIN_GROUPS)[number]

export interface RowOption {
  value: string
  label: string
  // What choosing it means.
  line?: string
}

interface Base {
  // The setting's name in the settings and in the server's list of controls.
  key: string
  env: string
  group: AdminGroup
  label: string
  line: string
  // The key of the row it sits under.
  under?: string
  keywords?: string[]
}

export type AdminRow =
  | (Base & {
      kind: 'switch'
      // What off means, shown while it is off.
      off?: string
    })
  | (Base & {
      kind: 'choice'
      options: RowOption[]
      // A list with each option's line, instead of chips.
      list?: boolean
      // Shown under the choices.
      note?: string
    })
  | (Base & { kind: 'number'; min: number; max: number; unit: string })
  | (Base & { kind: 'targets' })
  // A list of usernames and server:role entries.
  | (Base & { kind: 'names' })
  // A control another section edits.
  | (Base & { kind: 'link'; to: string; action: string })
  // A control only the server config or its own editor sets.
  | (Base & { kind: 'info' })

export const adminRow = (key: string) => ADMIN_ROWS.find(r => r.key === key)

// The rows of a group that stand on their own, in order.
export const groupRows = (group: AdminGroup) =>
  ADMIN_ROWS.filter(r => r.group === group && r.under === undefined)

// The rows that sit under `key`.
export const rowsUnder = (key: string) => ADMIN_ROWS.filter(r => r.under === key)

// What search finds in the Features section.
export const featureSearchRows = (): SearchRow[] =>
  ADMIN_ROWS.map(r => ({
    section: r.kind === 'link' ? r.to : 'features',
    group: r.kind === 'link' ? undefined : r.group,
    id: r.key,
    label: r.label,
    line: [r.line, ...(r.kind === 'choice' ? r.options.map(o => o.label) : [])].join(' '),
    keywords: r.keywords,
    env: r.env,
  }))

// The options of the New accounts row: sign-on only shows only while it is the stored value,
// since no sign-in provider can be set up.
export const registrationOptions = (stored: SiteSettings['registration']): RowOption[] => {
  const row = adminRow('registration')
  const options = row?.kind === 'choice' ? row.options : []
  return options.flatMap(o => {
    if (o.value !== 'sso') return [o]
    return stored === 'sso'
      ? [{ ...o, line: 'No sign-in provider is set up, so nobody can sign up.' }]
      : []
  })
}

// A setting's value as a row's control reads it.
export const settingOf = (settings: SiteSettings, key: string): unknown =>
  (settings as unknown as Record<string, unknown>)[key]
