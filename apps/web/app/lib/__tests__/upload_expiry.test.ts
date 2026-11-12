import { describe, expect, test } from 'bun:test'
import {
  removedLifetime,
  expiryChoice,
  expiryFromChoice,
  keptFullText,
  keptLimited,
  keptShown,
  keptSpace,
  keptText,
  newFilesText,
  ownerKept,
  lifetimeText,
  removedText,
  savedText,
  serverLifetime,
  serverPatch,
  sizeText,
  uploadHint,
  uploadLifetime,
} from '../upload_expiry'
import { DEFAULT_LIMITS, limitsOf } from '../instance_limits'
import type { InstanceInfo, SiteSettings } from '../types'
import { siteSettings } from '../features'
import { fieldLabel, valueText } from '../audit'

const DAY = 86400
const MIB = 1024 * 1024
const GIB = 1024 * MIB
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

  test('sizes are short', () => {
    const cases: [number, string][] = [
      [0, '0 B'],
      [900, '900 B'],
      [1024, '1 KB'],
      [700 * 1024, '700 KB'],
      [1.5 * MIB, '1.5 MB'],
      [3.14 * GIB, '3.1 GB'],
      [8 * GIB, '8 GB'],
      [1023.99 * GIB, '1 TB'],
      [2048 * GIB, '2 TB'],
    ]
    for (const [bytes, want] of cases) expect(sizeText(bytes)).toBe(want)
  })

  test('the kept space is read defensively', () => {
    expect(keptSpace({ bytes: 5, limit: 10, full: false })).toEqual({
      bytes: 5,
      limit: 10,
      full: false,
    })
    expect(keptSpace({ bytes: 5, limit: 0, full: true })).toEqual({
      bytes: 5,
      limit: 0,
      full: true,
    })
    for (const bad of [undefined, null, 'x', {}, { bytes: -1, limit: 1 }, { bytes: 1, limit: 'x' }])
      expect(keptSpace(bad)).toBe(null)
    expect(keptSpace({ bytes: 1, limit: 2 })).toEqual({ bytes: 1, limit: 2, full: false })
  })

  test("the owner's kept space is read defensively, with bytes only for the owner", () => {
    expect(ownerKept({ bytes: 5, limit: 10, full: true })).toEqual({
      bytes: 5,
      limit: 10,
      full: true,
    })
    expect(ownerKept({ bytes: null, limit: 10, full: false })).toEqual({
      bytes: null,
      limit: 10,
      full: false,
    })
    expect(ownerKept({ limit: 10 })).toEqual({ bytes: null, limit: 10, full: false })
    expect(ownerKept({ bytes: -1, limit: 10 })).toEqual({ bytes: null, limit: 10, full: false })
    for (const bad of [undefined, null, 'x', {}, { bytes: 1, limit: 'x' }, { bytes: 1, limit: -1 }])
      expect(ownerKept(bad)).toBe(null)
  })

  test('the usage line names the server, and for the charged account all it is charged for', () => {
    const kept = (bytes: number, limit: number) => ({ bytes, limit, full: false })
    const owner = (bytes: number | null, limit: number) => ({ bytes, limit, full: false })
    expect(keptText(kept(3.1 * GIB, 8 * GIB), owner(9.4 * GIB, 16 * GIB))).toBe(
      '3.1 GB of 8 GB kept in this server; 9.4 GB of 16 GB across the servers whose file expiry you set'
    )
    expect(keptText(kept(3.1 * GIB, 8 * GIB), owner(null, 16 * GIB))).toBe(
      '3.1 GB of 8 GB kept in this server'
    )
    expect(keptText(kept(3.1 * GIB, 8 * GIB), null)).toBe('3.1 GB of 8 GB kept in this server')
    expect(keptText(kept(0, 8 * GIB), owner(0, 16 * GIB))).toBe(
      '0 B of 8 GB kept in this server; 0 B of 16 GB across the servers whose file expiry you set'
    )
    expect(keptText(kept(3.1 * GIB, 0), owner(9.4 * GIB, 0))).toBe(
      '3.1 GB kept in this server; 9.4 GB across the servers whose file expiry you set'
    )
  })

  test('the usage line shows when the server keeps files longer, or still holds some', () => {
    const kept = (bytes: number) => ({ bytes, limit: GIB, full: false })
    expect(keptShown(null, null, DAY)).toBe(false)
    expect(keptShown(kept(0), DAY, DAY)).toBe(false)
    expect(keptShown(kept(0), 3600, DAY)).toBe(false)
    expect(keptShown(kept(0), null, DAY)).toBe(true)
    expect(keptShown(kept(0), 2 * DAY, DAY)).toBe(true)
    expect(keptShown(kept(1), DAY, DAY)).toBe(true)
  })

  test('the full line says which space is full, what happens, and who sets the limit', () => {
    const kept = (full: boolean) => ({ bytes: 1, limit: 2, full })
    const owner = (full: boolean, mine = true) => ({ bytes: mine ? 1 : null, limit: 2, full })
    const tail =
      " New files that don't fit are removed after 1 day until space frees up. The site admin sets the limit."
    expect(keptFullText(kept(true), owner(false), null, DAY)).toBe(
      `This server's space is full.${tail}`
    )
    expect(keptFullText(kept(false), owner(true), null, DAY)).toBe(
      `Your space across the servers whose file expiry you set is full.${tail}`
    )
    expect(keptFullText(kept(false), owner(true, false), 7 * DAY, DAY)).toBe(
      `The space of the account that set this file expiry is full.${tail}`
    )
    expect(keptFullText(kept(true), owner(true), null, DAY)).toBe(
      `This server's space and your space across the servers whose file expiry you set are full.${tail}`
    )
    expect(keptFullText(kept(true), owner(true, false), null, DAY)).toBe(
      `This server's space and the space of the account that set this file expiry are full.${tail}`
    )
    expect(keptFullText(kept(true), null, null, 7200)).toBe(
      "This server's space is full. New files that don't fit are removed after 2 hours until space frees up. The site admin sets the limit."
    )
    expect(keptFullText(kept(true), owner(true), null, DAY)).not.toContain('—')
  })

  test('the full line shows only while new files would stay longer', () => {
    const kept = (full: boolean) => ({ bytes: 1, limit: 2, full })
    expect(keptFullText(kept(true), null, DAY, DAY)).toBe(null)
    expect(keptFullText(kept(true), null, 3600, DAY)).toBe(null)
    expect(keptFullText(kept(false), null, null, DAY)).toBe(null)
    expect(keptFullText(null, null, null, DAY)).toBe(null)
  })

  test('the settings say what new files get, also while a space is full', () => {
    const kept = (limit: number, full: boolean) => ({ bytes: 1, limit, full })
    const owner = (full: boolean) => ({ bytes: 1, limit: 2, full })
    // No limit, or room in both spaces: the time is the time.
    expect(newFilesText(kept(0, false), null, null, DAY)).toBe('kept until removed')
    expect(newFilesText(null, null, null, DAY)).toBe('kept until removed')
    expect(newFilesText(kept(2, false), owner(false), null, DAY)).toBe('kept until removed')
    expect(newFilesText(kept(2, false), owner(false), 30 * DAY, DAY)).toBe('removed after 30 days')
    // A full space: a longer time holds only for a file that still fits.
    expect(newFilesText(kept(2, true), owner(false), null, DAY)).toBe(
      'removed after 1 day unless there is room to keep them longer'
    )
    expect(newFilesText(kept(2, false), owner(true), 30 * DAY, DAY)).toBe(
      'removed after 1 day unless there is room to keep them for 30 days'
    )
    // A time no longer than the default is never changed by a full space.
    expect(newFilesText(kept(2, true), owner(true), DAY, DAY)).toBe('removed after 1 day')
  })

  test('saving says how many files were extended and how many were left', () => {
    const x = (files: number, left_files: number) => ({
      files,
      bytes: files,
      left_files,
      left_bytes: left_files,
    })
    expect(savedText(undefined, DAY)).toBe('Saved.')
    expect(savedText(x(0, 0), DAY)).toBe('Saved.')
    expect(savedText(x(1, 0), DAY)).toBe('Saved. 1 file now stays longer.')
    expect(savedText(x(12, 0), DAY)).toBe('Saved. 12 files now stay longer.')
    expect(savedText(x(2, 1), DAY)).toBe(
      'Saved. 2 files now stay longer. 1 older file is still removed after 1 day: no room left.'
    )
    expect(savedText(x(0, 3), DAY)).toBe(
      'Saved. 3 older files are still removed after 1 day: no room left.'
    )
  })

  test('the upload hint is one sentence that is true whichever way the file turns out', () => {
    // No kept limit on the instance (or an older server): the time is the time.
    expect(uploadHint(null, DAY, false)).toBe('kept until removed')
    expect(uploadHint(7 * DAY, DAY, false)).toBe('removed after 1 week')
    // Kept limits exist: a longer time holds only while there is room, in the server and for
    // the account charged for its choice.
    expect(uploadHint(null, DAY, true)).toBe(
      'removed after 1 day unless there is room to keep it longer'
    )
    expect(uploadHint(7 * DAY, DAY, true)).toBe(
      'removed after 1 day unless there is room to keep it for 1 week'
    )
    expect(uploadHint(30 * DAY, 7200, true)).toBe(
      'removed after 2 hours unless there is room to keep it for 30 days'
    )
    // A time no longer than the default is never changed by a limit.
    for (const limited of [true, false]) {
      expect(uploadHint(DAY, DAY, limited)).toBe('removed after 1 day')
      expect(uploadHint(3600, DAY, limited)).toBe('removed after 1 hour')
    }
  })

  test('a limited instance never promises a time the file may not get', () => {
    for (const lifetime of [null, 2 * DAY, 30 * DAY]) {
      const hint = uploadHint(lifetime, DAY, true)
      expect(hint.startsWith('removed after 1 day unless there is room')).toBe(true)
      expect(hint).not.toContain('this server')
      expect(hint).not.toContain('kept until removed')
    }
  })

  test('the instance says whether kept files are limited', () => {
    const info = (limits: unknown) => ({ limits }) as unknown as InstanceInfo
    expect(keptLimited(info({ upload_kept_limited: true }))).toBe(true)
    expect(keptLimited(info({ upload_kept_limited: false }))).toBe(false)
    // Older servers have no such limits and send nothing.
    for (const none of [info({}), info(undefined), info({ upload_kept_limited: 'yes' }), null])
      expect(keptLimited(none)).toBe(false)
  })

  test('a saved setting updates the server detail without the response extras', () => {
    const state = {
      upload_expiry: NEVER,
      upload_ttl: null,
      kept: { bytes: 5, limit: 10, full: false },
      owner_kept: { bytes: 9, limit: 10, full: true },
      extended: { files: 1, bytes: 5, left_files: 0, left_bytes: 0 },
    }
    expect(serverPatch(state)).toEqual({ upload_expiry: NEVER, upload_ttl: null })
    expect(serverPatch({ upload_expiry: DEFAULT, upload_ttl: DAY })).toEqual({
      upload_expiry: DEFAULT,
      upload_ttl: DAY,
    })
  })

  test('the instance default comes from the instance limits', () => {
    expect(DEFAULT_LIMITS.media_retention_secs).toBe(DAY)
    const info = { limits: { media_retention_secs: 7200 } } as unknown as InstanceInfo
    expect(limitsOf(info).media_retention_secs).toBe(7200)
  })
})
