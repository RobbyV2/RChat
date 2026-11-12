import { afterAll, describe, expect, test } from 'bun:test'
import { maskedName, showsUsername } from '../display_name'
import { guestLabel, guestRef, isGuestName, voiceSelf } from '../guest_voice'
import { resetSessionCaches, userRefFor, useStore } from '../store'
import { me } from './fixtures'

afterAll(resetSessionCaches)

const name = '@guest:3f9a1c2b00000000'

describe('guests in voice', () => {
  test('a guest name is one no account or webhook can have', () => {
    expect(isGuestName(name)).toBe(true)
    for (const other of ['guest', 'guest:3f9a', '@webhook:7', 'alice', '', null, undefined])
      expect(isGuestName(other)).toBe(false)
  })

  test('guests show as Guest and the start of their tag, never as a username', () => {
    expect(guestLabel(name)).toBe('Guest 3f9a')
    const ref = guestRef(name)
    expect(ref).toEqual({
      username: name,
      display_name: 'Guest 3f9a',
      avatar_kind: 'identicon',
      avatar_color: null,
    })
    expect(showsUsername(ref)).toBe(false)
    const hideAll = (text: string) => text.replace(/\S/g, '*')
    expect(maskedName(guestRef('@guest:a55e000000000000'), hideAll)).toBe('Guest a55e')
    expect(maskedName({ username: 'bob', display_name: 'Bob' }, hideAll)).toBe('***')
    expect(userRefFor(useStore.getState(), name)).toEqual(ref)
  })

  test('the tab is in voice as its account, else as its guest name', () => {
    expect(voiceSelf({ me: me('alice'), guest: false, guestVoiceName: null })).toBe('alice')
    expect(voiceSelf({ me: null, guest: true, guestVoiceName: name })).toBe(name)
    expect(voiceSelf({ me: null, guest: true, guestVoiceName: null })).toBeNull()
    expect(voiceSelf({ me: null, guest: false, guestVoiceName: name })).toBeNull()
  })
})
