import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { EncryptionStatus } from '../../components/admin/encryption'
import {
  BACKUP_WARNING,
  fingerprints,
  jobPlace,
  keySavedLine,
  keySourceLine,
  keySourceNote,
  LOST_WARNING,
  lostKeys,
  MISMATCH_WARNING,
  parseAdminEncryption,
  placesLine,
  readinessLine,
  RESET_SHOWN_FOR,
  resetWarning,
  runningJob,
  SET_KEYS,
  unreadableLine,
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
  required: { on: false, pinned: false },
  unreadable: 0,
  copies_confirmed: null,
  places: { servers: 0, dms: 0 },
  jobs: [],
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

test('the page says where encrypted storage is on, what did not open and the jobs', () => {
  expect(placesLine(view())).toBe('No server or DM stores new messages encrypted.')
  expect(placesLine(view({ places: { servers: 1, dms: 0 } }))).toBe(
    'New messages are stored encrypted in 1 server.'
  )
  expect(placesLine(view({ places: { servers: 2, dms: 1 } }))).toBe(
    'New messages are stored encrypted in 2 servers and 1 DM.'
  )
  expect(
    placesLine(view({ places: { servers: 0, dms: 3 }, required: { on: true, pinned: false } }))
  ).toBe('Every server and DM stores new messages encrypted.')
  expect(unreadableLine(view())).toBeNull()
  expect(unreadableLine(view({ unreadable: 1 }))).toBe(
    "1 stored record couldn't be opened since this copy started."
  )
  expect(unreadableLine(view({ unreadable: 1200 }))).toBe(
    "1,200 stored records couldn't be opened since this copy started."
  )
  expect(jobPlace('*')).toEqual({ text: 'Every place', name: false })
  expect(jobPlace('s:den')).toEqual({ text: 'den', name: true })
  expect(jobPlace('d:7')).toEqual({ text: 'A DM', name: false })
  const at = Date.UTC(2026, 10, 24, 19, 42) / 1000
  expect(keySavedLine(at, at * 1000, { locale: 'en-US', timeZone: 'UTC' })).toBe(
    'Key copy saved on November 24, 2026 at 7:42 PM.'
  )
  const jobs = [
    {
      id: 2,
      place: '*',
      direction: 'unseal' as const,
      upto: 10,
      done: 5,
      from: 0,
      state: 'running' as const,
    },
    {
      id: 1,
      place: 's:den',
      direction: 'seal' as const,
      upto: 10,
      done: 10,
      from: 0,
      state: 'done' as const,
    },
  ]
  expect(runningJob(view({ jobs }))).toBe(true)
  expect(runningJob(view({ jobs: jobs.slice(1) }))).toBe(false)
  const html = renderToStaticMarkup(
    <EncryptionStatus
      view={view({ source: 'file', backed_up_at: at, unreadable: 2, jobs })}
      now={at * 1000}
    />
  )
  expect(html).toContain('data-backed-up')
  expect(html).toContain('data-unreadable')
  expect(html).toContain('Every place')
  expect(html).toContain('Storing messages plain: 50%')
  expect(html).toContain('<span class="min-w-0 text-sm break-words streamer">den</span>')
  expect(html).toContain('Earlier messages are stored encrypted.')
})

test('the new parts of the answer are read defensively', () => {
  const parsed = parseAdminEncryption({
    source: 'none',
    required: { on: true, pinned: 1 },
    unreadable: -3,
    copies_confirmed: false,
    places: { servers: 2, dms: 'x' },
    jobs: [
      { place: 's:den', direction: 'seal', upto: 4, done: 2, state: 'running', id: 1 },
      { place: 's:den', direction: 'sideways', upto: 4, done: 2, state: 'running' },
      { direction: 'unseal', upto: 1.5, done: 0, state: 'done' },
      null,
    ],
  })!
  expect(parsed.required).toEqual({ on: true, pinned: false })
  expect(parsed.unreadable).toBe(0)
  expect(parsed.copies_confirmed).toBe(false)
  expect(parsed.places).toEqual({ servers: 2, dms: 0 })
  expect(parsed.jobs).toEqual([
    { id: 1, place: 's:den', direction: 'seal', upto: 4, done: 2, from: 0, state: 'running' },
  ])
  expect(
    parseAdminEncryption({ source: 'none', copies_confirmed: 'yes' })!.copies_confirmed
  ).toBeNull()
})
