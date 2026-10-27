// Screen capture shared by the hub-relayed and the P2P call paths.

export const SCREEN_BITRATE = 2_500_000
export const SCREEN_FPS = 30

const SCREEN_VIDEO: MediaTrackConstraints = {
  width: { max: 1920 },
  height: { max: 1080 },
  frameRate: { ideal: SCREEN_FPS, max: SCREEN_FPS },
}

export interface ScreenCapture {
  video: MediaStreamTrack
  audio: MediaStreamTrack | null
  // System audio was left out by the echo rule below, so the sharer is told.
  audioNote: boolean
}

let shares = 0
// Tells one share from the next, so a stage focuses each new share once.
export const nextShareId = (prefix: string) => `${prefix}${++shares}`

// Keeps the stream object a peer is shown with and swaps its tracks, so the
// media elements playing it carry on.
export function syncStream(stream: MediaStream | null, tracks: (MediaStreamTrack | null)[]) {
  const wanted = tracks.filter((t): t is MediaStreamTrack => t !== null)
  if (!stream) return new MediaStream(wanted)
  for (const t of stream.getTracks()) if (!wanted.includes(t)) stream.removeTrack(t)
  for (const t of wanted) if (!stream.getTracks().includes(t)) stream.addTrack(t)
  return stream
}

export const canShareScreen = () =>
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'

const cancelled = (e: unknown) =>
  typeof e === 'object' &&
  e !== null &&
  'name' in e &&
  (e.name === 'NotAllowedError' || e.name === 'AbortError')

// Asks the browser to leave this page's own playback, the other people in
// the call, out of a tab or system audio capture, so listeners never hear
// themselves back. Members a browser doesn't know are ignored.
export const SCREEN_AUDIO = { restrictOwnAudio: true, suppressLocalAudioPlayback: false }

type Settings = MediaTrackSettings & { restrictOwnAudio?: boolean; displaySurface?: string }
const settings = (t: MediaStreamTrack): Settings =>
  typeof t.getSettings === 'function' ? (t.getSettings() as Settings) : {}

export interface ShareAudioFacts {
  // The video's displaySurface: 'browser' for a tab, 'window', 'monitor'.
  surface: string | undefined
  // The capture came with an audio track.
  audio: boolean
  // That track confirms restrictOwnAudio in its settings.
  restricted: boolean
  // The browser lists restrictOwnAudio among its supported constraints.
  canRestrict: boolean
}

// Whether the share's audio is sent, and whether to tell the sharer that
// system audio isn't. Anything but a tab can carry all system output, our
// own playback of the call included, unless the browser confirms it left
// that out; sent anyway, it would echo the call back to everyone. A tab is
// never ours (selfBrowserSurface: 'exclude'), so its audio is always kept.
// A whole screen that came without audio on a browser that can't leave our
// playback out gets the note too: we would have dropped it all the same.
export function shareAudio(f: ShareAudioFacts): { keep: boolean; note: boolean } {
  if (f.audio) {
    const keep = f.restricted || f.surface === 'browser'
    return { keep, note: !keep }
  }
  return { keep: false, note: f.surface === 'monitor' && !f.canRestrict }
}

async function restricts(audio: MediaStreamTrack) {
  if (settings(audio).restrictOwnAudio === true) return true
  try {
    await audio.applyConstraints({ restrictOwnAudio: true } as MediaTrackConstraints)
  } catch {
    // Not supported here.
  }
  return settings(audio).restrictOwnAudio === true
}

const canRestrict = () => {
  try {
    const supported = navigator.mediaDevices.getSupportedConstraints?.() as
      (MediaTrackSupportedConstraints & { restrictOwnAudio?: boolean }) | undefined
    return supported?.restrictOwnAudio === true
  } catch {
    return false
  }
}

// Asks for a screen, window or tab with its audio where the browser offers
// it. Older browsers that reject the richer options get a plain request.
// Resolves to null when the user closes the picker.
export async function captureScreen(): Promise<ScreenCapture | null> {
  const md = navigator.mediaDevices
  let media: MediaStream
  try {
    media = await md
      .getDisplayMedia({
        video: SCREEN_VIDEO,
        audio: SCREEN_AUDIO,
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
      } as DisplayMediaStreamOptions)
      .catch((e: unknown) => {
        if (e instanceof TypeError) return md.getDisplayMedia({ video: true })
        throw e
      })
  } catch (e) {
    if (cancelled(e)) return null
    throw e
  }
  const video = media.getVideoTracks()[0]
  if (!video) {
    for (const t of media.getTracks()) t.stop()
    return null
  }
  if ('contentHint' in video) video.contentHint = 'detail'
  let audio: MediaStreamTrack | null = media.getAudioTracks()[0] ?? null
  const surface = settings(video).displaySurface
  const restricted = audio !== null && surface !== 'browser' && (await restricts(audio))
  const plan = shareAudio({
    surface,
    audio: audio !== null,
    restricted,
    canRestrict: canRestrict(),
  })
  if (audio && !plan.keep) {
    audio.stop()
    audio = null
  }
  if (audio && 'contentHint' in audio) audio.contentHint = 'music'
  return { video, audio, audioNote: plan.note }
}

// Caps the encoder for a screen sender and keeps text sharp rather than
// smooth when bandwidth is short. Each step is applied on its own, so a
// browser that rejects one still gets the other; browsers without
// setParameters, or a sender not negotiated yet, just send with defaults.
export async function tuneScreen(sender: RTCRtpSender) {
  if (typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function')
    return
  const apply = async (edit: (params: RTCRtpSendParameters) => boolean) => {
    try {
      const params = sender.getParameters()
      if (edit(params)) await sender.setParameters(params)
    } catch {
      // Not supported here; the defaults apply.
    }
  }
  await apply(params => {
    const [enc] = params.encodings ?? []
    if (!enc || (enc.maxBitrate === SCREEN_BITRATE && enc.maxFramerate === SCREEN_FPS)) return false
    enc.maxBitrate = SCREEN_BITRATE
    enc.maxFramerate = SCREEN_FPS
    return true
  })
  await apply(params => {
    const p = params as RTCRtpSendParameters & { degradationPreference?: string }
    if (!p.encodings?.length || p.degradationPreference === 'maintain-resolution') return false
    p.degradationPreference = 'maintain-resolution'
    return true
  })
}
