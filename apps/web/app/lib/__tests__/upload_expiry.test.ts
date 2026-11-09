import { describe, expect, test } from 'bun:test'
import {
  removedLifetime,
  expiryChoice,
  expiryFromChoice,
  lifetimeText,
  removedText,
  serverLifetime,
  uploadLifetime,
} from '../upload_expiry'
import { DEFAULT_LIMITS, limitsOf } from '../instance_limits'
import type { InstanceInfo, SiteSettings } from '../types'
import { siteSettings } from '../features'
import { fieldLabel, valueText } from '../audit'

const DAY = 86400
const custom = (seconds: number) => ({ mode: 'custom' as const, seconds })
const NEVER = { mode: 'never' as const, seconds: null }
const DEFAULT = { mode: 'default' as const, seconds: null }

describe('upload expiry', () => {
  test('each mode gives a new file its lifetime under the cap', () => {
    const cases: [Parameters<typeof uploadLifetime>[0], number, number | null][] = [
      [undefined, 0, DAY],
      [DEFAULT, 0, DAY],
      [DEFAULT, 7, DAY],
      [custom(3600), 0, 3600],
      [custom(30 * DAY), 7, 7 * DAY],
      [custom(7 * DAY), 7, 7 * DAY],
      [NEVER, 0, null],
      [NEVER, 90, 90 * DAY],
    ]
    for (const [choice, cap, want] of cases) expect(uploadLifetime(choice, cap, DAY)).toBe(want)
  })

  test('a server detail uses its choice, the cap and the instance default', () => {
    expect(serverLifetime(undefined, 0, DAY)).toBe(DAY)
    expect(serverLifetime({ upload_expiry: NEVER }, 0, DAY)).toBe(null)
    expect(serverLifetime({ upload_expiry: NEVER }, 2, DAY)).toBe(2 * DAY)
    expect(serverLifetime({ upload_ttl: 3600 }, 0, DAY)).toBe(3600)
    expect(serverLifetime({ upload_ttl: null }, 0, DAY)).toBe(null)
  })

  test("a removed file shows its own lifetime, not the server's setting now", () => {
    const posted = 1_000_000
    expect(removedLifetime(posted + DAY - 12, posted, 7 * DAY)).toBe(DAY)
    expect(removedLifetime(posted + 3600 - 40, posted, null)).toBe(3600)
    expect(removedLifetime(posted + 90, posted, DAY)).toBe(120)
    expect(removedLifetime(null, posted, 7 * DAY)).toBe(7 * DAY)
    expect(removedLifetime(null, posted, null)).toBe(null)
    expect(removedLifetime(posted - 5, posted, DAY)).toBe(DAY)
    expect(removedText('a.png', removedLifetime(posted + DAY, posted, null))).toBe(
      'File a.png was removed after 1 day of posting'
    )
  })

  test('copy names the real time', () => {
    expect(lifetimeText(DAY)).toBe('removed after 1 day')
    expect(lifetimeText(2 * 3600)).toBe('removed after 2 hours')
    expect(lifetimeText(null)).toBe('kept until removed')
    expect(removedText('a.png', DAY)).toBe('File a.png was removed after 1 day of posting')
    expect(removedText('a.png', 3 * DAY)).toBe('File a.png was removed after 3 days of posting')
    expect(removedText('a.png', null)).toBe('File a.png was removed')
  })

  test('the settings form reads and writes the choice', () => {
    expect(expiryChoice(undefined)).toEqual({ mode: 'default', amount: 1, unit: 'days' })
    expect(expiryChoice(NEVER)).toEqual({ mode: 'never', amount: 1, unit: 'days' })
    expect(expiryChoice(custom(3 * 3600))).toEqual({ mode: 'custom', amount: 3, unit: 'hours' })
    expect(expiryChoice(custom(14 * DAY))).toEqual({ mode: 'custom', amount: 14, unit: 'days' })
    expect(expiryFromChoice({ mode: 'custom', amount: 3, unit: 'hours' })).toEqual(custom(3 * 3600))
    expect(expiryFromChoice({ mode: 'custom', amount: 365, unit: 'days' })).toEqual(
      custom(365 * DAY)
    )
    expect(expiryFromChoice({ mode: 'custom', amount: 0, unit: 'hours' })).toBe(null)
    expect(expiryFromChoice({ mode: 'custom', amount: 366, unit: 'days' })).toBe(null)
    expect(expiryFromChoice({ mode: 'custom', amount: 1.5, unit: 'days' })).toBe(null)
    expect(expiryFromChoice({ mode: 'never', amount: 5, unit: 'days' })).toEqual(NEVER)
    expect(expiryFromChoice({ mode: 'default', amount: 5, unit: 'days' })).toEqual(DEFAULT)
  })

  test('the cap from the instance is read defensively', () => {
    const settings = (v: unknown) =>
      siteSettings({ upload_expiry_max_days: v } as unknown as SiteSettings).upload_expiry_max_days
    expect(settings(30)).toBe(30)
    expect(settings(0)).toBe(0)
    for (const bad of [undefined, -1, 'x', Number.NaN, 2.5]) expect(settings(bad)).toBe(0)
  })

  test('the audit log names the change', () => {
    expect(fieldLabel('upload_expiry')).toBe('File expiry')
    expect(valueText('upload_expiry', 7200)).toBe('2 hours')
    expect(valueText('upload_expiry', 'never')).toBe('Never')
    expect(valueText('upload_expiry', 'default')).toBe('Default')
  })

  test('the instance default comes from the instance limits', () => {
    expect(DEFAULT_LIMITS.media_retention_secs).toBe(DAY)
    const info = { limits: { media_retention_secs: 7200 } } as unknown as InstanceInfo
    expect(limitsOf(info).media_retention_secs).toBe(7200)
  })
})
