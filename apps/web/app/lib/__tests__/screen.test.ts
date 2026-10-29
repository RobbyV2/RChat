import { afterEach, describe, expect, test } from 'bun:test'
import { captureScreen, SCREEN_BITRATE, SCREEN_FPS, shareAudio, tuneScreen } from '../screen'

interface Params {
  encodings: { maxBitrate?: number; maxFramerate?: number }[]
  degradationPreference?: string
}

function sender(opts: { encodings?: number; preset?: boolean; rejectDegradation?: boolean } = {}) {
  const enc = opts.preset ? { maxBitrate: SCREEN_BITRATE, maxFramerate: SCREEN_FPS } : {}
  let params: Params = {
    encodings: Array.from({ length: opts.encodings ?? 1 }, () => ({ ...enc })),
  }
  let sets = 0
  return {
    get params() {
      return params
    },
    get sets() {
      return sets
    },
    getParameters: () => structuredClone(params),
    async setParameters(next: Params) {
      if (opts.rejectDegradation && next.degradationPreference !== params.degradationPreference)
        throw new Error('degradationPreference not supported')
      sets++
      params = structuredClone(next)
    },
  }
}

describe('tuneScreen', () => {
  test('caps bitrate and frame rate and keeps resolution', async () => {
    const s = sender()
    await tuneScreen(s as unknown as RTCRtpSender)
    expect(s.params.encodings[0]).toEqual({ maxBitrate: SCREEN_BITRATE, maxFramerate: SCREEN_FPS })
    expect(s.params.degradationPreference).toBe('maintain-resolution')
  })

  test('a browser that rejects the degradation preference still gets the caps', async () => {
    const s = sender({ rejectDegradation: true })
    await tuneScreen(s as unknown as RTCRtpSender)
    expect(s.params.encodings[0].maxBitrate).toBe(SCREEN_BITRATE)
    expect(s.params.degradationPreference).toBeUndefined()
  })

  test('caps set up front still get the degradation preference, once', async () => {
    const s = sender({ preset: true })
    await tuneScreen(s as unknown as RTCRtpSender)
    expect(s.params.degradationPreference).toBe('maintain-resolution')
    const after = s.sets
    expect(after).toBe(1)
    await tuneScreen(s as unknown as RTCRtpSender)
    expect(s.sets).toBe(after)
  })

  test('a sender that is not negotiated yet is left alone', async () => {
    const s = sender({ encodings: 0 })
    await tuneScreen(s as unknown as RTCRtpSender)
    expect(s.sets).toBe(0)
  })

  test('a browser without setParameters is left alone', async () => {
    await tuneScreen({} as RTCRtpSender)
  })
})

class Track {
  contentHint = ''
  stopped = false
  constraints: Record<string, unknown> = {}
  constructor(
    public kind: 'audio' | 'video',
    private base: Record<string, unknown> = {},
    private applies = false
  ) {}
  stop() {
    this.stopped = true
  }
  getSettings() {
    return { ...this.base, ...(this.applies ? this.constraints : {}) }
  }
  async applyConstraints(c: Record<string, unknown>) {
    this.constraints = c
  }
}

const media = (tracks: Track[]) => ({
  getTracks: () => tracks,
  getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
  getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
})

describe('captureScreen', () => {
  const g = globalThis as { navigator?: unknown }
  const real = g.navigator
  afterEach(() => {
    g.navigator = real
  })
  const asked: unknown[] = []
  const display = (answer: (opts: unknown) => unknown, supported: Record<string, boolean> = {}) => {
    asked.length = 0
    g.navigator = {
      mediaDevices: {
        getSupportedConstraints: () => supported,
        getDisplayMedia: async (opts: unknown) => {
          asked.push(opts)
          return answer(opts)
        },
      },
    }
  }

  test('asks for audio without our own playback, and tags the tracks', async () => {
    const video = new Track('video', { displaySurface: 'browser' })
    const audio = new Track('audio')
    display(() => media([video, audio]))
    const got = await captureScreen()
    const { audio: wanted, systemAudio, selfBrowserSurface } = asked[0] as Record<string, unknown>
    expect({ wanted, systemAudio, selfBrowserSurface }).toEqual({
      wanted: { restrictOwnAudio: true, suppressLocalAudioPlayback: false },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
    })
    expect(got?.video === (video as unknown)).toBe(true)
    expect(got?.audio === (audio as unknown)).toBe(true)
    expect(video.contentHint).toBe('detail')
    expect(audio.contentHint).toBe('music')
  })

  test('a browser that rejects the richer options gets a plain request', async () => {
    const video = new Track('video')
    display(opts => {
      if (asked.length === 1) throw new TypeError('unknown option')
      expect(opts).toEqual({ video: true })
      return media([video])
    })
    const got = await captureScreen()
    expect(asked).toHaveLength(2)
    expect(got?.video === (video as unknown)).toBe(true)
    expect(got?.audio).toBe(null)
  })

  test('a closed picker resolves to null, other errors still throw', async () => {
    for (const name of ['NotAllowedError', 'AbortError']) {
      display(() => {
        throw Object.assign(new Error('closed'), { name })
      })
      expect(await captureScreen()).toBe(null)
      expect(asked).toHaveLength(1)
    }
    display(() => {
      throw Object.assign(new Error('busy'), { name: 'NotReadableError' })
    })
    const failed = await captureScreen().then(
      () => null,
      (e: unknown) => (e as Error).message
    )
    expect(failed).toBe('busy')
  })

  test('whole-screen audio that may carry our own playback is not sent', async () => {
    const video = new Track('video', { displaySurface: 'monitor' })
    const audio = new Track('audio', { restrictOwnAudio: false })
    display(() => media([video, audio]))
    const got = await captureScreen()
    expect(got?.video === (video as unknown)).toBe(true)
    expect(got?.audio).toBe(null)
    expect(audio.stopped).toBe(true)
    expect(audio.constraints).toEqual({ restrictOwnAudio: true })
    expect(got?.audioNote).toBe(true)
  })

  test('window audio is held to the same rule, tab audio is always kept', async () => {
    const win = new Track('audio', { restrictOwnAudio: false })
    display(() => media([new Track('video', { displaySurface: 'window' }), win]))
    const shared = await captureScreen()
    expect(shared?.audio).toBe(null)
    expect(shared?.audioNote).toBe(true)
    const tab = new Track('audio', { restrictOwnAudio: false })
    display(() => media([new Track('video', { displaySurface: 'browser' }), tab]))
    const got = await captureScreen()
    expect(got?.audio === (tab as unknown)).toBe(true)
    expect(got?.audioNote).toBe(false)
    expect(tab.stopped).toBe(false)
  })

  test('a whole screen without audio gets the note only where we would drop it', async () => {
    display(() => media([new Track('video', { displaySurface: 'monitor' })]))
    expect((await captureScreen())?.audioNote).toBe(true)
    display(() => media([new Track('video', { displaySurface: 'monitor' })]), {
      restrictOwnAudio: true,
    })
    expect((await captureScreen())?.audioNote).toBe(false)
    display(() => media([new Track('video', { displaySurface: 'browser' })]))
    expect((await captureScreen())?.audioNote).toBe(false)
  })

  test('whole-screen audio is kept where the browser leaves our playback out', async () => {
    for (const [base, applies] of [
      [{ restrictOwnAudio: true }, false],
      [{ restrictOwnAudio: false }, true],
    ] as const) {
      const audio = new Track('audio', base, applies)
      display(() => media([new Track('video', { displaySurface: 'monitor' }), audio]))
      const got = await captureScreen()
      expect(got?.audio === (audio as unknown)).toBe(true)
      expect(audio.stopped).toBe(false)
      expect(got?.audioNote).toBe(false)
    }
  })

  test('a capture without video is stopped and dropped', async () => {
    const audio = new Track('audio')
    display(() => media([audio]))
    expect(await captureScreen()).toBe(null)
    expect(audio.stopped).toBe(true)
  })
})

describe('shareAudio', () => {
  const facts = { surface: 'monitor', audio: true, restricted: false, canRestrict: true }

  test('whole-screen or window audio is dropped, with the note, unless restricted', () => {
    for (const surface of ['monitor', 'window', undefined]) {
      expect(shareAudio({ ...facts, surface })).toEqual({ keep: false, note: true })
      expect(shareAudio({ ...facts, surface, restricted: true })).toEqual({
        keep: true,
        note: false,
      })
    }
  })

  test('tab audio is kept without the note, restricted or not', () => {
    for (const restricted of [false, true])
      for (const canRestrict of [false, true])
        expect(shareAudio({ ...facts, surface: 'browser', restricted, canRestrict })).toEqual({
          keep: true,
          note: false,
        })
  })

  test('no audio gets the note only for a whole screen the browser could not restrict', () => {
    const none = { ...facts, audio: false }
    expect(shareAudio({ ...none, canRestrict: false })).toEqual({ keep: false, note: true })
    expect(shareAudio(none)).toEqual({ keep: false, note: false })
    for (const surface of ['browser', 'window'])
      expect(shareAudio({ ...none, surface, canRestrict: false })).toEqual({
        keep: false,
        note: false,
      })
  })
})
