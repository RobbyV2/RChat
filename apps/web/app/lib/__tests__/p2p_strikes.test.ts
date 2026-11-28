import { describe, expect, test } from 'bun:test'
import { b64u } from '../p2p/canonical'
import { keyId, newKeyPair } from '../p2p/keys'
import type { Session } from '../p2p/session'
import { readCallFrame, readRtcFrame } from '../p2p/signal'
import { badSignature, malformed, Strike, unentitled, volume, type Read } from '../p2p/strike'
import { readVoiceFrame, readVoiceRefuse, readVoiceRtc } from '../p2p/voice'

const ik = keyId(newKeyPair().pk)
const dk = keyId(newKeyPair().pk)
const room = b64u(new Uint8Array(32).fill(3))
const id = b64u(new Uint8Array(16).fill(5))
const sig = b64u(new Uint8Array(64).fill(1))
const CH = b64u(new Uint8Array(8).fill(9))

const call = { t: 'call', op: 'end', id, room }
const rtc = { t: 'rtc', to: ik, target: { p2pRoom: room }, call: id, payload: { muted: true } }
const voice = { t: 'gvoice', room, ch: CH, on: true, n: 5, dk, sig }
const refuse = { t: 'gvrefuse', room, ch: CH, relays: ['turn.example.com'] }
const vrtc = { t: 'gvrtc', to: ik, target: { p2pRoom: room, ch: CH }, payload: { muted: true } }

const kind = (r: Read<unknown>) => ('v' in r ? 'frame' : 'unknown' in r ? 'unknown' : 'strike')

describe('what earns a strike', () => {
  test('a strike has one of four reasons, and nothing else makes one', () => {
    const reasons = [malformed('n'), badSignature('voice'), volume('push'), unentitled('rtc')]
    expect(reasons.map(r => [r.kind, r.what])).toEqual([
      ['malformed', 'n'],
      ['signature', 'voice'],
      ['volume', 'push'],
      ['unentitled', 'rtc'],
    ])
    const forged = Strike as unknown as new (key: symbol, kind: string, what: string) => Strike
    expect(() => new forged(Symbol('strike'), 'malformed', 'x')).toThrow()
    const strikes = (s: Session) => {
      // @ts-expect-error a strike needs its reason
      s.strike()
      // @ts-expect-error a count is not a reason
      s.strike(2)
      s.strike(malformed('n'))
    }
    expect(typeof strikes).toBe('function')
  })

  test('a field this version does not know costs nothing in any frame', () => {
    const more = { later: { x: 1 }, flag: true }
    expect(kind(readCallFrame({ ...call, ...more }))).toBe('frame')
    expect(kind(readRtcFrame({ ...rtc, ...more, payload: { muted: true, hold: 1 } }))).toBe('frame')
    expect(kind(readVoiceFrame({ ...voice, ...more }))).toBe('frame')
    expect(kind(readVoiceRefuse({ ...refuse, ...more }))).toBe('frame')
    expect(kind(readVoiceRtc({ ...vrtc, ...more, target: { ...vrtc.target, dm: 3 } }))).toBe(
      'frame'
    )
  })

  test('an op this version does not know is unknown, not a strike', () => {
    expect(readCallFrame({ ...call, op: 'hold', until: 5 })).toEqual({ unknown: true })
    expect(kind(readCallFrame({ ...call, op: 'x'.repeat(33) }))).toBe('strike')
  })

  test('a malformed audio note leaves the voice frame standing without it', () => {
    const read = readVoiceFrame({ ...voice, aud: { sig: 'short', m: true } })
    expect('v' in read && read.v.aud).toBeUndefined()
  })

  test('a malformed known field earns a strike that names it', () => {
    const named = (r: Read<unknown>) => ('strike' in r ? `${r.strike.kind} ${r.strike.what}` : null)
    expect(named(readCallFrame({ ...call, id: 'short' }))).toBe('malformed id')
    expect(named(readCallFrame({ ...call, op: 'ring' }))).toBe('malformed video')
    expect(named(readCallFrame({ ...call, room: 5 }))).toBe('malformed room')
    expect(named(readCallFrame(null))).toBe('malformed call')
    expect(named(readRtcFrame({ ...rtc, to: 'bob' }))).toBe('malformed to')
    expect(named(readRtcFrame({ ...rtc, payload: { muted: 'yes' } }))).toBe('malformed payload')
    expect(named(readVoiceFrame({ ...voice, n: -1 }))).toBe('malformed n')
    expect(named(readVoiceFrame({ ...voice, on: 'yes' }))).toBe('malformed on')
    expect(named(readVoiceFrame({ ...voice, sig: 'short' }))).toBe('malformed sig')
    expect(named(readVoiceRefuse({ ...refuse, relays: 'x' }))).toBe('malformed relays')
    expect(named(readVoiceRtc({ ...vrtc, target: { p2pRoom: room } }))).toBe('malformed target')
  })
})
