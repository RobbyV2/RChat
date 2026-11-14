import { afterAll, describe, expect, test } from 'bun:test'
import { maskedName, showsUsername } from '../display_name'
import {
  GUESTS_NO_VOICE,
  STAFF_MUTED,
  audibleStreams,
  guestLabel,
  guestRef,
  guestVoiceActions,
  guestVoiceOff,
  isGuestName,
  voiceSelf,
} from '../guest_voice'
import { resetSessionCaches, userRefFor, useStore } from '../store'
import { me, serverDetail } from './fixtures'

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

describe('staff and guests in voice', () => {
  const Kick = 4
  const Timeout = 128

  test('staff get only the actions their permissions allow, on guests only', () => {
    expect(guestVoiceActions(name, 0, false)).toEqual([])
    expect(guestVoiceActions(name, Kick, false)).toEqual(['disconnect'])
    expect(guestVoiceActions(name, Timeout, false)).toEqual(['mute'])
    expect(guestVoiceActions(name, Timeout, true)).toEqual(['unmute'])
    expect(guestVoiceActions(name, Kick | Timeout, true)).toEqual(['unmute', 'disconnect'])
    expect(guestVoiceActions('bob', 1023, false)).toEqual([])
  })

  test('a staff-muted peer is never played, whatever it sends', () => {
    const mic = { id: 'mic' } as unknown as MediaStream
    const screen = { id: 'screen' } as unknown as MediaStream
    const bob = { id: 'bob' } as unknown as MediaStream
    const streams: [string, MediaStream][] = [
      [name, mic],
      [`${name}:screen`, screen],
      ['bob', bob],
    ]
    expect(audibleStreams(streams, [name], false)).toEqual([
      { key: 'bob', stream: bob, muted: false },
    ])
    expect(audibleStreams(streams, [], true)).toEqual([
      { key: name, stream: mic, muted: true },
      { key: `${name}:screen`, stream: screen, muted: true },
      { key: 'bob', stream: bob, muted: true },
    ])
    expect(audibleStreams(streams, ['bob'], false).map(a => a.key)).toEqual([
      name,
      `${name}:screen`,
    ])
  })

  test('a staff mute says so', () => {
    expect(STAFF_MUTED).toBe('Muted by staff')
  })
})

describe('servers that keep guests out of voice', () => {
  const servers = {
    lounge: serverDetail('lounge', { guest_voice: false }),
    open: serverDetail('open', { guest_voice: true }),
    old: serverDetail('old'),
  }

  test('only a guest in a server with the option off is kept out, with the reason', () => {
    const guest = { me: null, guest: true, servers }
    expect(guestVoiceOff(guest, 'lounge')).toBe(GUESTS_NO_VOICE)
    expect(guestVoiceOff(guest, 'open')).toBeNull()
    expect(guestVoiceOff(guest, 'old')).toBeNull()
    expect(guestVoiceOff(guest, 'missing')).toBeNull()
    expect(guestVoiceOff({ me: me('alice'), guest: false, servers }, 'lounge')).toBeNull()
    expect(GUESTS_NO_VOICE).toBe("Guests can't use voice in this server")
  })
})
