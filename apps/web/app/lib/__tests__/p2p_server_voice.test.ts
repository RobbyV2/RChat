import { afterEach, describe, expect, test } from 'bun:test'
import { Hub, ManualClock } from './p2p_net'
import { general, joinWithCode, makeMember, pump, stopAll, type Member } from './p2p_server_net'
import { NO_VOICE, type VoiceMedia } from '../p2p/voice'

afterEach(stopAll)

class FakeMedia implements VoiceMedia {
  users: string[] = []
  async join() {}
  sync(users: string[]) {
    this.users = users
  }
  leave() {
    this.users = []
  }
  async onSignal() {}
}

const plan = { config: { iceServers: [] }, declared: [], hidesIp: false }

const listed = (m: Member, room: string, ch: string) =>
  (m.servers.view(room)?.voice[ch] ?? []).map(u => u.ik).sort()

const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: Error) => e.message
  )

describe('P2P server voice channels', () => {
  test('three join, all list and connect to each other, one leaves and the others go on', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const c = await makeMember(hub, 'Carol', clock)
    const room = await a.servers.create('Voice club')
    await joinWithCode(clock, a, room, b)
    await joinWithCode(clock, a, room, c)
    const ch = await a.servers.addChannel(room, 'Lounge', { kind: 'voice' })
    await pump(
      clock,
      () =>
        [b, c].every(m =>
          m.servers.view(room)?.channels.some(x => x.id === ch && x.kind === 'voice')
        ),
      'the voice channel arrives'
    )
    // Text stays where it was: the system channel is still a text one.
    expect(a.servers.view(room)?.system.ch).toBe(general(a, room))
    expect(a.servers.isChannel(room, ch)).toBe(false)
    expect(a.servers.isVoiceChannel(room, ch)).toBe(true)

    const media = new Map<Member, FakeMedia>()
    for (const m of [a, b, c]) {
      const fake = new FakeMedia()
      media.set(m, fake)
      m.servers.voice.media = fake
      await m.servers.voice.join(room, ch, { plan, muted: false })
    }
    const all = [a, b, c].map(m => m.node.ik).sort()
    await pump(
      clock,
      () => [a, b, c].every(m => listed(m, room, ch).join() === all.join()),
      'everyone lists all three',
      2_000
    )
    await pump(
      clock,
      () => [a, b, c].every(m => [...media.get(m)!.users].sort().join() === all.join()),
      'everyone connects media to the other two',
      2_000
    )
    // Sessions with participants are kept outside the rooms' budget.
    expect(a.servers.voice.keeps(b.node.ik)).toBe(true)
    expect(a.servers.voice.keeps(c.node.ik)).toBe(true)

    c.servers.voice.leave()
    const two = [a, b].map(m => m.node.ik).sort()
    await pump(
      clock,
      () =>
        [a, b].every(
          m =>
            listed(m, room, ch).join() === two.join() &&
            [...media.get(m)!.users].sort().join() === two.join()
        ),
      'the others go on without Carol',
      2_000
    )
    expect(listed(c, room, ch)).toEqual(two)
    expect(a.servers.voice.keeps(c.node.ik)).toBe(false)
    // Still there after several refreshes.
    await clock.advance(70_000)
    await pump(clock, () => listed(a, room, ch).join() === two.join(), 'still listed', 2_000)
  }, 120_000)

  test('we leave voice when our channel is deleted or we lose view of it', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Voice club')
    await joinWithCode(clock, a, room, b)
    const ch = await a.servers.addChannel(room, 'Lounge', { kind: 'voice' })
    const ch2 = await a.servers.addChannel(room, 'Stage', { kind: 'voice' })
    await pump(
      clock,
      () => [ch, ch2].every(id => b.servers.view(room)?.channels.some(x => x.id === id)),
      'the channels arrive'
    )
    b.servers.voice.media = new FakeMedia()
    await b.servers.voice.join(room, ch, { plan, muted: false })
    await a.servers.editChannel(room, ch, { gone: true })
    await pump(clock, () => b.servers.voice.current() === null, 'out of the deleted channel')
    await b.servers.voice.join(room, ch2, { plan, muted: false })
    // Only who may view it now: Bob may not.
    await a.servers.editChannel(room, ch2, { restrict_view: true } as { name?: string })
    await pump(clock, () => b.servers.voice.current() === null, 'out of the channel Bob lost')
  }, 120_000)

  test('a view answer for a state that changed meanwhile is asked again, never cached', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Voice club')
    await joinWithCode(clock, a, room, b)
    const ch = await a.servers.addChannel(room, 'Lounge', { kind: 'voice' })
    const inner = a.servers as unknown as {
      host: { viewable: (...x: unknown[]) => Promise<boolean[]> }
      rts: Map<string, { sum: object; views: Map<string, boolean> }>
    }
    const rt = inner.rts.get(room)!
    // The first answer (yes) comes for a state that a revocation replaced meanwhile; the second
    // (asked again) says no.
    const answers = [true, false]
    inner.host.viewable = async () => {
      const ok = answers.shift() ?? false
      if (ok) rt.sum = { ...rt.sum }
      return [ok]
    }
    expect(await a.servers.voiceAllowed(room, ch, b.node.ik)).toBe(false)
    expect(rt.views.get(`${b.node.ik}\n${ch}`)).toBe(false)
  }, 120_000)

  test('a channel only some may view: others can neither join nor see who is in it', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Staff')
    await joinWithCode(clock, a, room, b)
    const ch = await a.servers.addChannel(room, 'Office', { kind: 'voice', restrictView: true })
    await pump(clock, () => !!b.servers.sumOf(room).channels[ch], 'the channel arrives')
    // A channel Bob may not view isn't listed for him at all (Task 23 view gate).
    expect(b.servers.view(room)?.channels.some(x => x.id === ch)).toBe(false)
    a.servers.voice.media = new FakeMedia()
    b.servers.voice.media = new FakeMedia()
    await a.servers.voice.join(room, ch, { plan, muted: false })
    expect(listed(a, room, ch)).toEqual([a.node.ik])
    await clock.advance(25_000)
    await pump(clock, () => true, 'settled')
    expect(listed(b, room, ch)).toEqual([])
    expect(await failure(b.servers.voice.join(room, ch, { plan, muted: false }))).toBe(NO_VOICE)
    // Leaving the room leaves its voice.
    await a.servers.voice.join(room, ch, { plan, muted: false })
    expect(a.servers.voice.current()).toEqual({ room, ch })
    await a.servers.leave(room)
    await pump(clock, () => a.servers.voice.current() === null, 'out of voice')
  }, 120_000)
})
