import { describe, expect, test } from 'bun:test'
import {
  CandidateQueue,
  descriptionAction,
  JoinTracker,
  mergeStatus,
  statusOf,
  mayOffer,
  newSid,
  sameScope,
  Serial,
  sidAction,
  slotLayout,
  videoPlan,
} from '../negotiation'

describe('signal scope', () => {
  test('matches only the session it was sent for', () => {
    expect(sameScope({ channelId: 3 }, { channelId: 3, dmId: null })).toBe(true)
    expect(sameScope({ channelId: 3 }, { channelId: 4, dmId: null })).toBe(false)
    expect(sameScope({ dmId: 7 }, { channelId: null, dmId: 7 })).toBe(true)
    expect(sameScope({ dmId: 7 }, { channelId: 7, dmId: null })).toBe(false)
    expect(sameScope({ channelId: 3 }, { channelId: 3, dmId: 3 })).toBe(false)
    expect(sameScope(null, { channelId: 3 })).toBe(false)
  })
})

describe('description handling', () => {
  const st = (polite: boolean, signalingState: RTCSignalingState, makingOffer = false) => ({
    polite,
    makingOffer,
    negotiated: true,
    signalingState,
  })

  test('an offer in stable state is applied by either side', () => {
    expect(descriptionAction('offer', st(true, 'stable'))).toBe('apply')
    expect(descriptionAction('offer', st(false, 'stable'))).toBe('apply')
  })

  test('glare: impolite ignores, polite applies', () => {
    expect(descriptionAction('offer', st(false, 'have-local-offer'))).toBe('ignore')
    expect(descriptionAction('offer', st(true, 'have-local-offer'))).toBe('apply')
    expect(descriptionAction('offer', st(false, 'stable', true))).toBe('ignore')
    expect(descriptionAction('offer', st(true, 'stable', true))).toBe('apply')
  })

  test('the impolite side ignores offers until its own first one is answered', () => {
    const fresh = (polite: boolean) => ({ ...st(polite, 'stable'), negotiated: false })
    expect(descriptionAction('offer', fresh(false))).toBe('ignore')
    expect(descriptionAction('offer', fresh(true))).toBe('apply')
  })

  test('answers only land on a pending offer', () => {
    expect(descriptionAction('answer', st(false, 'have-local-offer'))).toBe('apply')
    expect(descriptionAction('answer', st(true, 'stable'))).toBe('stale')
    expect(descriptionAction('answer', st(true, 'have-remote-offer'))).toBe('stale')
    expect(descriptionAction('rollback', st(true, 'stable'))).toBe('stale')
  })
})

describe('first offer', () => {
  test('the polite side never makes the first offer', () => {
    expect(mayOffer(false, false)).toBe(true)
    expect(mayOffer(true, false)).toBe(false)
    expect(mayOffer(true, true)).toBe(true)
  })
})

describe('candidate queue', () => {
  test('holds candidates until the remote description is set', () => {
    const q = new CandidateQueue<string>()
    expect(q.accept('a', { hasRemote: false, ignoring: false })).toBe('hold')
    expect(q.accept('b', { hasRemote: false, ignoring: false })).toBe('hold')
    expect(q.size).toBe(2)
    expect(q.drain()).toEqual(['a', 'b'])
    expect(q.drain()).toEqual([])
    expect(q.accept('c', { hasRemote: true, ignoring: false })).toBe('add')
    expect(q.size).toBe(0)
  })

  test('drops candidates of an ignored offer', () => {
    const q = new CandidateQueue<string>()
    expect(q.accept('a', { hasRemote: false, ignoring: true })).toBe('drop')
    expect(q.size).toBe(0)
    expect(q.accept('b', { hasRemote: true, ignoring: true })).toBe('add')
  })
})

describe('serial steps', () => {
  test('a later step waits for an earlier slow one', async () => {
    const s = new Serial()
    const log: string[] = []
    let release = () => {}
    const gate = new Promise<void>(r => (release = r))
    const first = s.run(async () => {
      log.push('offer start')
      await gate
      log.push('offer done')
    })
    const second = s.run(async () => {
      log.push('remote offer')
    })
    await Promise.resolve()
    expect(log).toEqual(['offer start'])
    release()
    await Promise.all([first, second])
    expect(log).toEqual(['offer start', 'offer done', 'remote offer'])
  })

  test('a failing step does not stop the ones after it', async () => {
    const s = new Serial()
    const failed = s.run(() => Promise.reject(new Error('boom')))
    const next = s.run(() => Promise.resolve(2))
    expect(
      await failed.then(
        () => 'ok',
        (e: Error) => e.message
      )
    ).toBe('boom')
    expect(await next).toBe(2)
  })
})

describe('session ids', () => {
  test('are random hex', () => {
    const a = newSid()
    expect(/^[0-9a-f]{16}$/.test(a)).toBe(true)
    expect(a === newSid()).toBe(false)
  })

  test('the first one is adopted, a new one replaces the peer, a retired one is dropped', () => {
    expect(sidAction(undefined, 's1', false)).toBe('accept')
    expect(sidAction('s1', 's1', false)).toBe('accept')
    expect(sidAction('s1', 's2', false)).toBe('replace')
    expect(sidAction('s2', 's1', true)).toBe('drop')
    expect(sidAction(undefined, 's1', true)).toBe('drop')
  })

  test('a legacy peer without ids keeps working, and a switch to or from one replaces', () => {
    expect(sidAction(undefined, undefined, false)).toBe('accept')
    expect(sidAction(null, undefined, false)).toBe('accept')
    expect(sidAction(null, 's1', false)).toBe('replace')
    expect(sidAction('s1', undefined, false)).toBe('replace')
  })
})

describe('slot layout', () => {
  test('a full first offer is read by position', () => {
    expect(slotLayout(['audio', 'audio', 'video', 'video'], false)).toEqual({
      screenAudio: 0,
      mic: 1,
      cam: 2,
      screen: 3,
    })
  })

  test('a legacy connection is read by kind order', () => {
    expect(slotLayout(['audio'], true)).toEqual({ mic: 0 })
    expect(slotLayout(['audio', 'video'], false)).toEqual({ mic: 0, cam: 1 })
    expect(slotLayout(['audio', 'audio', 'video', 'video'], true)).toEqual({
      mic: 0,
      screenAudio: 1,
      cam: 2,
      screen: 3,
    })
  })
})

describe('join tracking', () => {
  test('a quick A -> B -> A ignores the states from the first two joins', () => {
    const j = new JoinTracker()
    j.joined(1, false)
    j.joined(2, false)
    j.joined(1, false)
    expect(j.state(1, true)).toBe('stale')
    expect(j.state(1, false)).toBe('stale')
    expect(j.state(2, true)).toBe('stale')
    expect(j.state(2, false)).toBe('absent')
    expect(j.state(1, true)).toBe('listed')
    expect(j.state(1, false)).toBe('absent')
  })

  test('a state from someone else joining before our switch lands is stale', () => {
    const j = new JoinTracker()
    j.joined(1, false)
    expect(j.state(1, false)).toBe('stale')
    expect(j.state(1, true)).toBe('listed')
    j.joined(2, false)
    j.joined(1, true)
    // carol joined 1 before our switch to 2 was applied
    expect(j.state(1, true)).toBe('stale')
    expect(j.state(1, false)).toBe('stale')
    expect(j.state(1, true)).toBe('listed')
  })

  test('a leave and a quick rejoin wait for both', () => {
    const j = new JoinTracker()
    j.joined(1, false)
    expect(j.state(1, true)).toBe('listed')
    j.left()
    j.joined(1, true)
    expect(j.state(1, true)).toBe('stale')
    expect(j.state(1, false)).toBe('stale')
    expect(j.state(1, true)).toBe('listed')
  })

  test('a slot the server already holds for us counts as listed', () => {
    const j = new JoinTracker()
    j.joined(1, true)
    expect(j.state(1, true)).toBe('listed')
    const k = new JoinTracker()
    k.joined(1, true)
    // the old slot was dropped just before our join landed
    expect(k.state(1, false)).toBe('absent')
    expect(k.state(1, true)).toBe('listed')
  })

  test('a removal by the server is current, and the next join counts again', () => {
    const j = new JoinTracker()
    j.joined(1, false)
    expect(j.state(1, true)).toBe('listed')
    expect(j.state(1, false)).toBe('absent')
    j.joined(1, false)
    expect(j.state(1, false)).toBe('stale')
    expect(j.state(1, true)).toBe('listed')
  })

  test('a refused join does not hold back the next one', () => {
    const j = new JoinTracker()
    j.joined(1, false)
    expect(j.state(1, true)).toBe('listed')
    j.joined(2, false)
    j.refused()
    expect(j.state(1, true)).toBe('listed')
    j.joined(2, false)
    expect(j.state(1, false)).toBe('absent')
    expect(j.state(2, true)).toBe('listed')
    j.reset()
    expect(j.state(2, false)).toBe('absent')
  })

  test('an error that was not a refusal does not confuse it', () => {
    const j = new JoinTracker()
    j.joined(1, false)
    j.refused()
    expect(j.state(1, true)).toBe('listed')
    expect(j.state(1, false)).toBe('absent')
  })
})

describe('status signals', () => {
  test('only the media fields of a payload are status', () => {
    expect(statusOf({ screen: true, sid: 'a', candidate: {} } as never)).toEqual({ screen: true })
    expect(statusOf({ sid: 'a' } as never)).toBe(null)
    expect(statusOf({ muted: false, cam: false })).toEqual({ muted: false, cam: false })
  })

  test('a merge keeps fields the signal leaves out', () => {
    const prev = { muted: true, cam: true, screen: false }
    expect(mergeStatus(prev, { screen: true })).toEqual({ muted: true, cam: true, screen: true })
    expect(mergeStatus(prev, { cam: false, screen: undefined })).toEqual({
      muted: true,
      cam: false,
      screen: false,
    })
  })

  test('an old client never sends screen, so its share stays a camera', () => {
    expect(mergeStatus({}, { muted: false, cam: true })).toEqual({ muted: false, cam: true })
  })
})

describe('p2p slots', () => {
  // A P2P call sends its tracks as one stream in the order mic, screen
  // audio, camera, screen, and reads every connection by kind order.
  test('a new pair maps all four slots', () => {
    expect(slotLayout(['audio', 'audio', 'video', 'video'], true)).toEqual({
      mic: 0,
      screenAudio: 1,
      cam: 2,
      screen: 3,
    })
  })

  test("a 0.2.0 peer's two-track call maps to the mic and camera", () => {
    expect(slotLayout(['audio', 'video'], true)).toEqual({ mic: 0, cam: 1 })
    // Answering a 0.2.0 offer: the two offered m-lines first, then the
    // tracks it didn't offer, which never get negotiated.
    expect(slotLayout(['audio', 'video', 'audio', 'video'], true)).toEqual({
      mic: 0,
      cam: 1,
      screenAudio: 2,
      screen: 3,
    })
  })
})

describe('videoPlan', () => {
  test('a current peer gets the camera and screen on their own slots', () => {
    expect(videoPlan('cam', 'screen', false)).toEqual({ cam: 'cam', screen: 'screen' })
    expect(videoPlan(null, 'screen', false)).toEqual({ cam: null, screen: 'screen' })
  })

  test('a legacy peer gets the screen once, on the camera slot while the camera is off', () => {
    expect(videoPlan(null, 'screen', true)).toEqual({ cam: 'screen', screen: null })
    expect(videoPlan('cam', 'screen', true)).toEqual({ cam: 'cam', screen: null })
    expect(videoPlan('cam', null, true)).toEqual({ cam: 'cam', screen: null })
    expect(videoPlan(null, null, true)).toEqual({ cam: null, screen: null })
  })
})
