import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cleanBio, memberExtras } from '../profile_fields'
import { PROFILE_FIELDS, isProfilesMode, roomExtras } from '../server_profile'

const ASSET = fileURLToPath(new URL('../../../../../assets/profile_fields.json', import.meta.url))

test('the profile limits are the shared table', () => {
  expect(JSON.parse(readFileSync(ASSET, 'utf8'))).toEqual(
    JSON.parse(JSON.stringify(PROFILE_FIELDS))
  )
})

test('the room parsers hold the shared limits', () => {
  const { name, bio, modes } = PROFILE_FIELDS
  expect(roomExtras({ nick: 'n'.repeat(name.max) }).nick).toHaveLength(name.max)
  expect(roomExtras({ nick: 'n'.repeat(name.max + 1) }).nick).toBeUndefined()
  expect(roomExtras({ bio: 'b'.repeat(bio.max) }).bio).toHaveLength(bio.max)
  expect(roomExtras({ bio: 'b'.repeat(bio.max + 1) }).bio).toBeUndefined()
  expect(roomExtras({ bn: '#A1b2C3' }).bn).toBe('#a1b2c3')
  expect(roomExtras({ bn: '#a1b2c' }).bn).toBeUndefined()
  for (const mode of modes) expect(isProfilesMode(mode)).toBe(true)
  expect(isProfilesMode('names')).toBe(false)
})

test('a room description is cleaned as a hosted one is', () => {
  expect(cleanBio(' here \n\n\n\n now ')).toBe('here \n\n now')
  expect(cleanBio('\ta\u0007b\r\nc\u0000 ')).toBe('ab\nc')
  expect(roomExtras({ bio: 'one\n\n\n\ntwo\u0000' }).bio).toBe('one\n\ntwo')
  expect(roomExtras({ bio: '\n'.repeat(190) }).bio).toBeUndefined()
  expect(roomExtras({ bio: `${'\u0001'.repeat(190)}x` }).bio).toBe('x')
  expect(roomExtras({ bio: `${'b'.repeat(188)}\n\n\n\nc` }).bio).toBeUndefined()
  expect(roomExtras({ bio: `${'b'.repeat(187)}\n\n\n\nc` }).bio).toHaveLength(190)
})

test("a member's extras count only in the membership they were written in", () => {
  const profile = { name: 'Bob', nick: 'Robert', in: 'j1' }
  expect(memberExtras({ profile, joinId: 'j1' })).toEqual({ nick: 'Robert' })
  expect(memberExtras({ profile, joinId: 'j2' })).toEqual({})
  expect(memberExtras({ profile })).toEqual({})
  expect(memberExtras({ profile: { name: 'Bob', nick: 'Robert' }, joinId: 'j1' })).toEqual({})
  expect(memberExtras({ profile: null, joinId: 'j1' })).toEqual({})
  expect(memberExtras(undefined)).toEqual({})
})
