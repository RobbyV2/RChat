import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { P2pManager } from '../p2p'

let ids = 0

class FakeTrack {
  id = `t${++ids}`
  enabled = true
  contentHint = ''
  stopped = false
  onended: (() => void) | null = null
  constructor(public kind: 'audio' | 'video') {}
  stop() {
    this.stopped = true
  }
  // A captured video reads as a tab, whose audio is always shared.
  getSettings() {
    return this.kind === 'video' ? { displaySurface: 'browser' } : {}
  }
  clone() {
    return new FakeTrack(this.kind)
  }
}

class FakeStream {
  private tracks: FakeTrack[]
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks]
  }
  getTracks() {
    return [...this.tracks]
  }
  getAudioTracks() {
    return this.tracks.filter(t => t.kind === 'audio')
  }
  getVideoTracks() {
    return this.tracks.filter(t => t.kind === 'video')
  }
  addTrack(t: FakeTrack) {
    if (!this.tracks.includes(t)) this.tracks.push(t)
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter(x => x !== t)
  }
}

const slot = (kind: 'audio' | 'video', track: FakeTrack | null) => ({
  sender: {
    track,
    async replaceTrack(next: FakeTrack | null) {
      this.track = next
    },
  },
  receiver: { track: new FakeTrack(kind) },
})

type Handler = (arg?: unknown) => void

function control() {
  const on = new Map<string, Handler>()
  const sent: { type: string; on: boolean; share: boolean; screen?: boolean }[] = []
  return {
    open: true,
    sent,
    closed: false,
    on(event: string, cb: Handler) {
      on.set(event, cb)
    },
    emit(event: string, arg?: unknown) {
      on.get(event)?.(arg)
    },
    send(msg: (typeof sent)[number]) {
      sent.push(msg)
    },
    close() {
      this.closed = true
    },
  }
}

interface Internals {
  local: FakeStream | null
  placeholder: FakeTrack | null
  screenPlaceholder: FakeTrack | null
  silence: FakeTrack | null
  cameraTrack: FakeTrack | null
  screen: { video: FakeTrack; audio: FakeTrack | null } | null
  media: unknown
  detector: unknown
  ensurePeer: () => unknown
  attachControl: (conn: unknown) => void
}

const quiet = { onSpeak: () => {}, watch: () => {}, unwatch: () => {}, clear: () => {} }

const g = globalThis as Record<string, unknown>
const saved = {
  MediaStream: g.MediaStream,
  navigator: g.navigator,
  document: g.document,
  AudioContext: g.AudioContext,
}

let display: () => Promise<FakeStream>
let camera: () => Promise<FakeStream>

beforeEach(() => {
  ids = 0
  g.MediaStream = FakeStream
  display = async () => new FakeStream([new FakeTrack('video'), new FakeTrack('audio')])
  camera = async () => new FakeStream([new FakeTrack('video')])
  g.navigator = {
    mediaDevices: {
      getDisplayMedia: () => display(),
      getUserMedia: (c: { audio?: boolean }) =>
        c.audio ? Promise.resolve(new FakeStream([new FakeTrack('audio')])) : camera(),
    },
  }
})

afterEach(() => {
  Object.assign(g, saved)
})

// A call in progress: all four slots negotiated, in the P2P order.
function call() {
  const m = new P2pManager()
  const x = m as unknown as Internals
  x.detector = { ...quiet }
  x.ensurePeer = () => null
  const mic = new FakeTrack('audio')
  x.local = new FakeStream([mic])
  x.placeholder = new FakeTrack('video')
  x.screenPlaceholder = new FakeTrack('video')
  x.silence = new FakeTrack('audio')
  const slots = [
    slot('audio', mic),
    slot('audio', x.silence),
    slot('video', x.placeholder),
    slot('video', x.screenPlaceholder),
  ]
  x.media = { peerConnection: { getTransceivers: () => slots }, close() {} }
  const conn = control()
  x.attachControl(conn)
  const sending = () => ({
    screenAudio: slots[1].sender.track,
    cam: slots[2].sender.track,
    screen: slots[3].sender.track,
  })
  return { m, x, conn, sending }
}

const settle = () => new Promise(r => setTimeout(r, 0))

describe('p2p screen share', () => {
  test('a share goes out on the screen slots and is announced apart from the camera', async () => {
    const { m, x, conn, sending } = call()
    await m.toggleShare()
    await settle()
    expect(m.shareOn).toBe(true)
    expect(sending().screen).toBe(x.screen?.video ?? null)
    expect(sending().screenAudio).toBe(x.screen?.audio ?? null)
    expect(sending().cam).toBe(x.placeholder)
    expect(conn.sent.at(-1)).toEqual({ type: 'cam', on: false, share: true, screen: true })
    await m.toggleShare()
    await settle()
    expect(sending().screen).toBe(x.screenPlaceholder)
    expect(sending().screenAudio).toBe(x.silence)
  })

  test('a peer whose cam message has no screen is 0.2.0 and gets the screen on the camera slot', async () => {
    const { m, x, conn, sending } = call()
    await m.toggleShare()
    await settle()
    conn.emit('data', { type: 'cam', on: false, share: false })
    await settle()
    expect(sending().cam).toBe(x.screen?.video ?? null)
    expect(sending().screen).toBe(x.screenPlaceholder)
    expect([conn.sent.at(-1)?.on, conn.sent.at(-1)?.share]).toEqual([true, true])
    await m.toggleCamera()
    await settle()
    expect(sending().cam).toBe(x.cameraTrack)
    expect(sending().screen).toBe(x.screenPlaceholder)
    await m.toggleCamera()
    await settle()
    expect(sending().cam).toBe(x.screen?.video ?? null)
    await m.toggleShare()
    await settle()
    expect(sending().cam).toBe(x.placeholder)
    expect([conn.sent.at(-1)?.on, conn.sent.at(-1)?.share]).toEqual([false, false])
  })

  test('a share started once the peer is known to be 0.2.0 goes on the camera slot', async () => {
    const { m, x, conn, sending } = call()
    conn.emit('data', { type: 'cam', on: false, share: false })
    await m.toggleShare()
    await settle()
    expect(sending().cam).toBe(x.screen?.video ?? null)
    expect(sending().screen).toBe(x.screenPlaceholder)
    expect([conn.sent.at(-1)?.on, conn.sent.at(-1)?.share]).toEqual([true, true])
  })

  test('a current peer never gets the screen on the camera slot', async () => {
    const { m, x, conn, sending } = call()
    conn.emit('data', { type: 'cam', on: false, share: false, screen: false })
    await m.toggleShare()
    await settle()
    expect(sending().cam).toBe(x.placeholder)
    expect(m.remoteShareId).toBe(null)
    conn.emit('data', { type: 'cam', on: true, share: true, screen: true })
    expect(m.remoteCamOn).toBe(true)
    expect(m.remoteScreenOn).toBe(true)
    expect(typeof m.remoteShareId).toBe('string')
  })

  test('a screen picked after the call ended is stopped, not added to the next call', async () => {
    const { m, x } = call()
    let resolve: (s: FakeStream) => void = () => {}
    display = () => new Promise(r => (resolve = r))
    const pending = m.toggleShare()
    m.endMedia()
    x.local = new FakeStream([new FakeTrack('audio')])
    const late = new FakeTrack('video')
    resolve(new FakeStream([late]))
    await pending
    expect(late.stopped).toBe(true)
    expect(m.shareOn).toBe(false)
    expect(x.screen).toBe(null)
  })

  test('a camera picked after the call ended is stopped, not added to the next call', async () => {
    const { m, x } = call()
    let resolve: (s: FakeStream) => void = () => {}
    camera = () => new Promise(r => (resolve = r))
    const pending = m.toggleCamera()
    m.endMedia()
    x.local = new FakeStream([new FakeTrack('audio')])
    const late = new FakeTrack('video')
    resolve(new FakeStream([late]))
    await pending
    expect(late.stopped).toBe(true)
    expect(m.camOn).toBe(false)
    expect(x.cameraTrack).toBe(null)
  })

  test('ending the call stops every track and forgets the peer', async () => {
    const { m, x, conn } = call()
    await m.toggleShare()
    await m.toggleCamera()
    conn.emit('data', { type: 'cam', on: true, share: true, screen: true })
    const tracks = [
      ...(x.local?.getTracks() ?? []),
      x.placeholder,
      x.screenPlaceholder,
      x.silence,
      x.cameraTrack,
      x.screen?.video,
      x.screen?.audio,
    ]
    m.endMedia()
    expect(tracks.every(t => t?.stopped)).toBe(true)
    expect(conn.closed).toBe(true)
    expect([m.shareOn, m.camOn, m.remoteCamOn, m.remoteScreenOn]).toEqual([
      false,
      false,
      false,
      false,
    ])
    expect([m.shareId, m.remoteShareId, m.screenView, m.camView, m.local]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ])
  })
})

describe('p2p call setup', () => {
  test('without an AudioContext the screen audio slot still gets a silent track', async () => {
    g.AudioContext = class {
      constructor() {
        throw new Error('no audio')
      }
    }
    g.document = {
      createElement: () => ({
        getContext: () => ({ fillRect() {} }),
        captureStream: () => new FakeStream([new FakeTrack('video')]),
      }),
    }
    const m = new P2pManager()
    const x = m as unknown as Internals
    x.detector = { ...quiet }
    x.ensurePeer = () => null
    await m.startMedia()
    const mic = x.local?.getAudioTracks()[0]
    expect(x.silence === null || x.silence === mic).toBe(false)
    expect(x.silence?.kind).toBe('audio')
    expect(x.silence?.enabled).toBe(false)
    const sent = (m as unknown as { callStream: () => FakeStream }).callStream()
    expect(sent.getTracks().map(t => t.kind)).toEqual(['audio', 'audio', 'video', 'video'])
    m.endMedia()
    expect(x.silence).toBe(null)
  })
})
