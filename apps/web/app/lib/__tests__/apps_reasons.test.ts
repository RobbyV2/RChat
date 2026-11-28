import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LIMIT_ROWS } from '../apps/limits'
import {
  APP_ERROR,
  appConflict,
  capacity,
  cliLine,
  conflict,
  fromApp,
  invalid,
  invalidLine,
  limit,
  locked,
  notFound,
  offAccount,
  offApp,
  offServer,
  offSite,
  rate,
  unavailable,
  type Reason,
  type ReasonKind,
  type Refusal,
} from '../apps/reasons'

const KINDS: Record<ReasonKind, true> = {
  off_site: true,
  off_account: true,
  off_server: true,
  off_app: true,
  limit: true,
  capacity: true,
  invalid: true,
  rate: true,
  conflict: true,
  sign_in: true,
  unavailable: true,
  locked: true,
  app: true,
  confirm: true,
  forced: true,
  keys: true,
  perm: true,
}

const ascii = (s: string) => /^[\x20-\x7e]+$/.test(s)

describe('refusals', () => {
  test('something hidden or missing is the uniform answer with no reason', () => {
    expect(notFound()).toEqual({ error: 'Not found' })
    expect('reason' in notFound()).toBe(false)
  })

  test('an invalid value names its field', () => {
    expect(invalid('parent', 'must be an existing record')).toEqual({
      error: 'parent must be an existing record.',
      reason: { kind: 'invalid', field: 'parent' },
    })
    expect(invalid('cursor', 'is no longer good; start this list again')).toEqual({
      error: 'cursor is no longer good; start this list again.',
      reason: { kind: 'invalid', field: 'cursor' },
    })
  })

  test('an invalid value may carry a whole sentence instead', () => {
    expect(invalidLine('index', "This list isn't open to you.")).toEqual({
      error: "This list isn't open to you.",
      reason: { kind: 'invalid', field: 'index' },
    })
  })

  test('a conflict carries its line', () => {
    expect(conflict('That already exists.')).toEqual({
      error: 'That already exists.',
      reason: { kind: 'conflict' },
    })
  })

  test('a conflict in the words of an app keeps them out of the error', () => {
    expect(appConflict('Classroom', 'That code is taken.')).toEqual({
      error: 'That already exists.',
      reason: { kind: 'conflict', app: 'Classroom', text: 'That code is taken.' },
    })
    expect(appConflict('Classroom', 'x'.repeat(300)).reason?.text).toBe('x'.repeat(200))
  })

  test('a turned-off control names the control at each level', () => {
    expect(offSite('apps', 'Actions are off on this site.')).toEqual({
      error: 'Actions are off on this site.',
      reason: { kind: 'off_site', control: 'apps' },
    })
    expect(offAccount('guest', 'Sign in to take part.')).toEqual({
      error: 'Sign in to take part.',
      reason: { kind: 'off_account', control: 'guest' },
    })
    expect(offServer('apps_encrypted', "Apps aren't available in encrypted servers yet.")).toEqual({
      error: "Apps aren't available in encrypted servers yet.",
      reason: { kind: 'off_server', control: 'apps_encrypted' },
    })
    expect(offApp('comments', 'Comments are off for this file.')).toEqual({
      error: 'Comments are off for this file.',
      reason: { kind: 'off_app', control: 'comments' },
    })
  })

  test('a rate, a full resource and a fault say when to try again or what failed', () => {
    expect(rate('app_actions_per_min', 60, 'Too many actions. Try again in a minute.')).toEqual({
      error: 'Too many actions. Try again in a minute.',
      reason: { kind: 'rate', control: 'app_actions_per_min', retry_after: 60 },
    })
    expect(
      capacity('app_instance_gib', 3600, 'This site is out of space for app files right now.')
    ).toEqual({
      error: 'This site is out of space for app files right now.',
      reason: { kind: 'capacity', control: 'app_instance_gib', retry_after: 3600 },
    })
    expect(unavailable('action_backstop', 'This action took too long.')).toEqual({
      error: 'This action took too long.',
      reason: { kind: 'unavailable', control: 'action_backstop' },
    })
  })

  test('a fault says when to try again when that is known', () => {
    expect(
      unavailable('apps_database', 'Apps are not answering. Try again in a moment.', 5)
    ).toEqual({
      error: 'Apps are not answering. Try again in a moment.',
      reason: { kind: 'unavailable', control: 'apps_database', retry_after: 5 },
    })
  })
})

describe('a refusal by the app itself', () => {
  test('has a fixed plain error, with the words of the author in the reason', () => {
    const r = fromApp('Classroom', 'That course code is not right.')
    expect(r.error).toBe(APP_ERROR)
    expect(r.error).toBe('Refused by the app.')
    expect(r.reason).toEqual({
      kind: 'app',
      app: 'Classroom',
      text: 'That course code is not right.',
    })
  })

  test('never lets the words of an author into the error', () => {
    const r = fromApp('Classroom', 'RChat: your session expired. Sign in again — at evil.example')
    expect(r.error).toBe('Refused by the app.')
    expect(ascii(r.error)).toBe(true)
    expect(r.reason?.text).toBe('RChat: your session expired. Sign in again — at evil.example')
  })

  test('cuts the words of an author at 200 characters', () => {
    expect(fromApp('Forms', 'y'.repeat(500)).reason?.text).toBe('y'.repeat(200))
  })

  test('cuts by characters, so a character beyond the basic plane stays whole', () => {
    const words = `${'y'.repeat(199)}😀😀`
    expect(fromApp('Forms', words).reason?.text).toBe(`${'y'.repeat(199)}😀`)
    expect(appConflict('Forms', words).reason?.text).toBe(`${'y'.repeat(199)}😀`)
    expect(fromApp('Forms', '😀'.repeat(300)).reason?.text).toBe('😀'.repeat(200))
  })

  test('a text client says who is speaking', () => {
    expect(cliLine(fromApp('Classroom', 'That course code is not right.'))).toBe(
      'Classroom says: That course code is not right.'
    )
    expect(cliLine(notFound())).toBe('Not found')
    expect(cliLine(appConflict('Classroom', 'That code is taken.'))).toBe('That already exists.')
    expect(cliLine(invalidLine('index', "This list isn't open to you."))).toBe(
      "This list isn't open to you."
    )
  })
})

describe('a refusal at a limit', () => {
  test('says which limit, the numbers and who can change it', () => {
    expect(limit('file_mib', '30.0 MiB', '25 MiB')).toEqual({
      error: 'Largest file: 30.0 MiB of 25 MiB. The site admin can raise it.',
      reason: {
        kind: 'limit',
        control: 'app_file_max_mib',
        used: '30.0 MiB',
        cap: '25 MiB',
        who: 'operator',
      },
    })
  })

  test('names the server owner when the owner set it', () => {
    expect(limit('file_mib', '30.0 MiB', '10 MiB', 'owner')).toEqual({
      error:
        'Largest file: 30.0 MiB of 10 MiB. The server owner set it and can raise it up to the site limit.',
      reason: {
        kind: 'limit',
        control: 'app_file_max_mib',
        used: '30.0 MiB',
        cap: '10 MiB',
        who: 'owner',
      },
    })
  })

  test('names the app when its author set it', () => {
    expect(limit('doc_kib', '600 KiB', '512 KiB', 'author')).toEqual({
      error:
        'Largest document or sheet (its current content): 600 KiB of 512 KiB. This app sets it; the server owner can ask its author.',
      reason: {
        kind: 'limit',
        control: 'app_doc_kib',
        used: '600 KiB',
        cap: '512 KiB',
        who: 'author',
      },
    })
  })

  test('sends the owner of a row only the operator sets to the site admin', () => {
    expect(limit('apps_per_dm', '5', '5', 'owner').error).toBe(
      'Apps in one DM: 5 of 5. The site admin can raise it.'
    )
  })

  test('names every limit as the server names its limits, its env name in lower case, in plain ASCII', () => {
    for (const r of LIMIT_ROWS)
      for (const who of ['operator', 'owner', 'author'] as const) {
        const x = limit(r.key, '2', '1', who)
        const control = r.env.toLowerCase()
        expect(/^[a-z][a-z0-9_]*$/.test(control)).toBe(true)
        expect(x.reason).toEqual({ kind: 'limit', control, used: '2', cap: '1', who })
        expect(x.error.startsWith(`${r.what}: 2 of 1. `)).toBe(true)
        expect(ascii(x.error)).toBe(true)
      }
  })
})

describe('the shape', () => {
  test('every kind is one of the kinds every API error uses', () => {
    const made: Refusal[] = [
      invalid('f', 'x'),
      invalidLine('f', 'x'),
      conflict('x'),
      appConflict('a', 'x'),
      offSite('c', 'x'),
      offAccount('c', 'x'),
      offServer('c', 'x'),
      offApp('c', 'x'),
      rate('c', 1, 'x'),
      capacity('c', 1, 'x'),
      unavailable('c', 'x'),
      fromApp('a', 'x'),
      limit('subs', '1', '1'),
      locked(9, 'x'),
    ]
    for (const r of made) expect(KINDS[(r.reason as Reason).kind]).toBe(true)
    expect(new Set(made.map(r => r.reason?.kind)).size).toBe(12)
  })

  test('the kinds and the shared fields are the ones the errors of the server have', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../server/src/api/error.rs', import.meta.url)),
      'utf8'
    )
    const body = (name: string) =>
      new RegExp(`pub (?:enum|struct) ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source)![1]
    const snake = (s: string) => s.replace(/(?!^)([A-Z])/g, '_$1').toLowerCase()
    const kinds = [...body('ReasonKind').matchAll(/^ {4}(\w+),$/gm)].map(m => snake(m[1]))
    expect(kinds.sort()).toEqual(Object.keys(KINDS).sort())
    const fields = [...body('Reason').matchAll(/^ {4}pub (\w+):/gm)].map(m => m[1])
    expect(fields.sort()).toEqual(['channel', 'control', 'field', 'kind', 'retry_after', 'until'])
    const ours = new Set(
      [
        invalid('f', 'x'),
        rate('c', 1, 'x'),
        fromApp('a', 'x'),
        limit('subs', '1', '1'),
        locked(9, 'x'),
      ].flatMap(r => Object.keys(r.reason ?? {}))
    )
    const serverOnly = ['channel']
    for (const field of fields.filter(f => !serverOnly.includes(f)))
      expect(ours.has(field)).toBe(true)
    expect([...ours].filter(k => !fields.includes(k)).sort()).toEqual([
      'app',
      'cap',
      'text',
      'used',
      'who',
    ])
  })

  test('a reason holds only the fields its kind needs', () => {
    const keys = (r: Refusal) => Object.keys(r.reason ?? {}).sort()
    expect(keys(invalid('f', 'x'))).toEqual(['field', 'kind'])
    expect(keys(rate('c', 1, 'x'))).toEqual(['control', 'kind', 'retry_after'])
    expect(keys(unavailable('c', 'x'))).toEqual(['control', 'kind'])
    expect(keys(unavailable('c', 'x', 1))).toEqual(['control', 'kind', 'retry_after'])
    expect(keys(fromApp('a', 'x'))).toEqual(['app', 'kind', 'text'])
    expect(keys(limit('subs', '1', '1'))).toEqual(['cap', 'control', 'kind', 'used', 'who'])
    expect(locked(9, 'x')).toEqual({ error: 'x', reason: { kind: 'locked', until: 9 } })
  })
})
