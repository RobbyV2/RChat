import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { EncryptionBody, EncryptionStatus, LOAD_FAILED } from '../../components/admin/encryption'
import {
  BACKUP_WARNING,
  fingerprints,
  keySourceLine,
  keySourceNote,
  LOST_WARNING,
  lostKeys,
  MISMATCH_WARNING,
  parseAdminEncryption,
  readinessLine,
  RESET_SHOWN_FOR,
  resetWarning,
  SET_KEYS,
  type AdminDataKey,
  type AdminEncryption,
} from '../admin_encryption'

const view = (part: Partial<AdminEncryption> = {}): AdminEncryption => ({
  source: 'none',
  fingerprints: [],
  key_file: null,
  database_key: false,
  backed_up_at: null,
  secrets_reset: null,
  data_keys: [],
  readiness: 'keys',
  needs_backup: false,
  ...part,
})

const fileView = view({
  source: 'file',
  fingerprints: ['k1:0a1b2c3d'],
  key_file: '/data/rchat.db.keys',
  readiness: 'ready',
  needs_backup: true,
})

test('the key source is named for each source', () => {
  expect(keySourceLine(view())).toBe('No key yet')
  expect(keySourceLine(view({ database_key: true }))).toBe('Stored with a key in the database')
  expect(keySourceLine(view({ source: 'operator' }))).toBe('Keys set in the server configuration')
  expect(keySourceLine(fileView)).toBe('Key file made by this site')
  expect(keySourceNote(view({ source: 'operator' }))).toBeNull()
  expect(keySourceNote(fileView)).toContain('ENCRYPTION_KEYS')
  expect(keySourceNote(view({ readiness: 'first_need' }))).toContain('A key is made')
  expect(readinessLine(view({ readiness: 'updating' }))).toBe(
    'Not available while this site updates.'
  )
})

test('promises a key on first use only where the site can make one', () => {
  const made = view({ readiness: 'first_need' })
  expect(readinessLine(made)).toBe(
    'Encrypted storage starts with the first server or DM that turns it on.'
  )
  expect(keySourceNote(made)).toContain('first turns on encrypted storage')
  expect(keySourceNote({ ...made, database_key: true })).toContain('starts when a server or DM')
  const none = view({ readiness: 'keys' })
  expect(readinessLine(none)).toBe(SET_KEYS)
  expect(keySourceNote(none)).toBeNull()
  expect(keySourceNote({ ...none, database_key: true })).toBe(
    'Stored secrets are protected against casual reads only.'
  )
  const html = renderToStaticMarkup(<EncryptionStatus view={none} />)
  expect(html).toContain('ENCRYPTION_KEYS_FILE')
  expect(html).not.toContain('first server or DM')
})

test('fingerprints list the key in use first and skip malformed entries', () => {
  expect(
    fingerprints(view({ fingerprints: ['k2:aaaaaaaa', 'k1:bbbbbbbb', 'junk', ':x'] }))
  ).toEqual([
    { id: 'k2', print: 'aaaaaaaa', current: true },
    { id: 'k1', print: 'bbbbbbbb', current: false },
  ])
})

test('the answer is read defensively', () => {
  for (const bad of [null, 'x', 1, {}, { source: 1 }]) expect(parseAdminEncryption(bad)).toBeNull()
  expect(parseAdminEncryption({ source: 'none' })).toEqual(view())
  const parsed = parseAdminEncryption({
    source: 'file',
    fingerprints: ['k1:0a1b2c3d', 7],
    key_file: '/data/rchat.db.keys',
    database_key: 'yes',
    backed_up_at: '5',
    secrets_reset: { at: '7', secrets: ['relay_secret'] },
    data_keys: [
      { id: 1, purpose: 'content', generation: 1, kek: 'k1', state: 'active', held: true },
      {
        id: 2,
        purpose: 'media',
        generation: 1,
        kek: 'k0',
        state: 'active',
        held: false,
        mismatch: true,
      },
      { id: 3, purpose: 'bus', generation: 1, kek: 'k0', state: 'destroyed', held: false },
      { purpose: 'search' },
      null,
    ],
    readiness: 'ready',
    needs_backup: true,
    later: 1,
  })
  expect({ ...parsed!, data_keys: fileView.data_keys }).toEqual(fileView)
  expect(parsed!.data_keys.map(k => k.id)).toEqual([1, 2, 3])
  expect(lostKeys(parsed!).map(k => k.id)).toEqual([2])
  expect(parsed!.data_keys.map(k => k.mismatch)).toEqual([false, true, false])
})

test('the page warns until the key file is backed up', () => {
  const html = renderToStaticMarkup(<EncryptionStatus view={fileView} />)
  expect(html).toContain('data-warning="backup"')
  expect(html).toContain(BACKUP_WARNING.replace("'", '&#x27;'))
  expect(html).toContain('data-key-source="file"')
  expect(html).toContain('/data/rchat.db.keys')
  expect(html).toContain('0a1b2c3d')
  expect(html).toContain('In use')
  expect(html).toContain('This is not end-to-end')
  const saved = renderToStaticMarkup(
    <EncryptionStatus view={{ ...fileView, needs_backup: false, backed_up_at: 5 }} />
  )
  expect(saved).not.toContain('data-warning')
})

test('the page says when no key exists and when one is missing', () => {
  const none = renderToStaticMarkup(<EncryptionStatus view={view()} />)
  expect(none).toContain('No key yet')
  expect(none).not.toContain('Key fingerprints')
  expect(none).not.toContain('data-warning')
  const dataKey = (part: Partial<AdminDataKey>): AdminDataKey => ({
    id: 1,
    purpose: 'content',
    generation: 1,
    kek: 'k1',
    state: 'active',
    held: false,
    mismatch: false,
    ...part,
  })
  const page = (keys: AdminDataKey[]) =>
    renderToStaticMarkup(
      <EncryptionStatus
        view={view({ source: 'operator', fingerprints: ['k2:aaaaaaaa'], data_keys: keys })}
      />
    )
  const lost = page([dataKey({})])
  expect(lost).toContain('data-warning="lost"')
  expect(lost).toContain(LOST_WARNING.replace("'", '&#x27;'))
  const wrong = page([dataKey({ mismatch: true })])
  expect(wrong).toContain(MISMATCH_WARNING.replace("'", '&#x27;'))
})

test('the page says which tokens were reset and when, for a month', () => {
  expect(
    parseAdminEncryption({
      source: 'none',
      secrets_reset: { at: 7, secrets: ['relay_secret', 3], later: 1 },
    })!.secrets_reset
  ).toEqual({ at: 7, secrets: ['relay_secret'] })
  expect(parseAdminEncryption({ source: 'none', secrets_reset: 7 })!.secrets_reset).toBeNull()
  const at = Date.UTC(2026, 10, 24, 19, 42) / 1000
  const o = { locale: 'en-US', timeZone: 'UTC' }
  const reset = (secrets: string[]) => view({ secrets_reset: { at, secrets } })
  const later = at * 1000 + 86400_000
  expect(resetWarning(reset(['relay_secret']), later, o)).toBe(
    "Relay tokens were reset on November 24, 2026 at 7:42 PM. The stored secret couldn't be opened."
  )
  expect(resetWarning(reset(['p2p_secret']), later, o)?.startsWith('P2P tokens were reset')).toBe(
    true
  )
  expect(resetWarning(reset(['relay_secret', 'p2p_secret']), later, o)).toBe(
    "Relay and P2P tokens were reset on November 24, 2026 at 7:42 PM. The stored secrets couldn't be opened."
  )
  expect(resetWarning(reset(['other']), later, o)?.startsWith('Tokens were reset on')).toBe(true)
  expect(resetWarning(view(), later, o)).toBeNull()
  const gone = (at + RESET_SHOWN_FOR + 1) * 1000
  expect(resetWarning(reset(['relay_secret']), gone, o)).toBeNull()
  const html = renderToStaticMarkup(<EncryptionStatus view={reset(['relay_secret'])} now={later} />)
  expect(html).toContain('data-warning="reset"')
  expect(html).toContain('Relay tokens were reset on')
  expect(
    renderToStaticMarkup(<EncryptionStatus view={reset(['relay_secret'])} now={gone} />)
  ).not.toContain('data-warning')
})

test('the section says when the status cannot be read', () => {
  expect(renderToStaticMarkup(<EncryptionBody view={null} />)).toContain('Loading')
  const failed = renderToStaticMarkup(<EncryptionBody view="failed" />)
  expect(failed).toContain(LOAD_FAILED.replace("'", '&#x27;'))
  expect(failed).not.toContain('Loading')
  expect(renderToStaticMarkup(<EncryptionBody view={view()} />)).toContain('data-key-source')
})
