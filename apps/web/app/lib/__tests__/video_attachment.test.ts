import { describe, expect, test } from 'bun:test'
import { primaryText } from '../file_card'
import { PREVIEW_MAX } from '../sniff'
import {
  failureMemory,
  hostedVideo,
  NEAR_SETTLE_MS,
  pillClass,
  remembersFailure,
  VIDEO_MAX_H,
  videoBox,
  videoClaim,
  watchPlaying,
} from '../video_attachment'
import { UrlCache } from '../p2p/files'

describe('videoClaim', () => {
  test('a video name or a declared video type a browser plays is tried inline', () => {
    const table: [string, string | null, boolean][] = [
      ['clip.mp4', null, true],
      ['clip.M4V', null, true],
      ['clip.webm', 'video/webm', true],
      ['phone.MOV', 'video/quicktime', true],
      ['clip.mp4', 'application/octet-stream', true],
      ['blob', 'video/mp4', true],
      ['blob', 'video/webm; codecs=vp9', true],
      ['movie.mkv', null, false],
      ['movie.avi', 'video/x-msvideo', false],
      ['movie.mkv', 'video/webm', true],
      ['blob', 'video/x-matroska', false],
      ['song.mp3', 'video/mp4', false],
      ['stream.ts', 'video/mp4', false],
      ['photo.png', 'video/mp4', false],
      ['report.pdf', null, false],
      ['blob', 'application/octet-stream', false],
      ['blob', null, false],
    ]
    expect(table.map(([name, mime]) => [name, mime, videoClaim(name, mime)])).toEqual(table)
  })
})

describe('hostedVideo', () => {
  const file = { filename: 'clip.mp4', mime: 'video/mp4', size: 2048, removed: false }

  test('plays from its address, or from fetched bytes where media loads that way', () => {
    expect(hostedVideo(file, true, 'url')).toBe('url')
    expect(hostedVideo(file, true, 'blob')).toBe('blob')
  })

  test('previews off, a removed file or a file that is no video keep the card', () => {
    expect(hostedVideo(file, false, 'url')).toBeNull()
    expect(hostedVideo({ ...file, removed: true }, true, 'url')).toBeNull()
    expect(hostedVideo({ ...file, filename: 'a.zip', mime: 'application/zip' }, true, 'url')).toBe(
      null
    )
  })

  test('fetched bytes are capped like a P2P preview; an address streams any size', () => {
    expect(hostedVideo({ ...file, size: PREVIEW_MAX }, true, 'blob')).toBe('blob')
    expect(hostedVideo({ ...file, size: PREVIEW_MAX + 1 }, true, 'blob')).toBeNull()
    expect(hostedVideo({ ...file, size: null }, true, 'blob')).toBeNull()
    expect(hostedVideo({ ...file, size: PREVIEW_MAX * 50 }, true, 'url')).toBe('url')
  })
})

describe('the download pill', () => {
  test('shows on hover and keyboard focus, and always on touch and narrow screens', () => {
    const cls = pillClass.split(' ')
    for (const c of [
      'opacity-0',
      'group-hover/video:opacity-100',
      'group-has-[:focus-visible]/video:opacity-100',
      'max-md:opacity-100',
      'pointer-coarse:opacity-100',
      'absolute',
      'top-2',
      'right-2',
    ])
      expect(cls).toContain(c)
  })

  test('hidden it sits lower and smaller, and carries no transition of its own', () => {
    const cls = pillClass.split(' ')
    expect(pillClass.includes('transition')).toBe(false)
    for (const c of [
      'translate-y-1',
      'scale-95',
      'group-hover/video:translate-y-0',
      'group-hover/video:scale-100',
      'pointer-coarse:translate-y-0',
      'pointer-coarse:scale-100',
      'max-md:scale-100',
    ])
      expect(cls).toContain(c)
  })

  test('its label names the shown file; the sender hint goes in the title only', () => {
    expect(primaryText('Download', 'clip.mp4')).toEqual({
      label: 'Download clip.mp4',
      title: 'Download clip.mp4',
    })
    expect(primaryText('Save', '****.mp4')).toEqual({
      label: 'Save ****.mp4',
      title: 'Save ****.mp4',
    })
    expect(primaryText('Download', 'clip.mp4', "from bob's browser")).toEqual({
      label: 'Download clip.mp4',
      title: "Download clip.mp4 from bob's browser",
    })
  })
})

describe('the box a video holds before it loads', () => {
  test('keeps its own size in pixels, no taller than the player', () => {
    expect(VIDEO_MAX_H).toBe(320)
    expect(videoBox(1920, 1080)).toEqual({ width: '569px', aspectRatio: '1920 / 1080' })
    expect(videoBox(1080, 1920)).toEqual({ width: '180px', aspectRatio: '1080 / 1920' })
    expect(videoBox(200, 100)).toEqual({ width: '200px', aspectRatio: '200 / 100' })
  })

  test('none without a size to go by', () => {
    expect(videoBox(undefined, 100)).toBeNull()
    expect(videoBox(100, 0)).toBeNull()
    expect(videoBox(-5, 10)).toBeNull()
  })
})

describe('fetched videos that fail to decode', () => {
  test('are remembered by key, and their watchers hear of each change', () => {
    const memory = failureMemory()
    let heard = 0
    const stop = memory.watch(() => heard++)
    expect(memory.has('a')).toBe(false)
    memory.mark('a')
    memory.mark('a')
    expect([memory.has('a'), memory.has('b'), heard]).toEqual([true, false, 1])
    memory.clear()
    expect([memory.has('a'), heard]).toEqual([false, 2])
    memory.clear()
    expect(heard).toBe(2)
    stop()
    memory.mark('b')
    expect(heard).toBe(2)
  })

  test('keep at most their cap, the oldest forgotten first', () => {
    const memory = failureMemory(2)
    for (const key of ['a', 'b', 'c']) memory.mark(key)
    expect(['a', 'b', 'c'].map(memory.has)).toEqual([false, true, true])
  })
})

describe('whether a video plays', () => {
  const fakeVideo = () => Object.assign(new EventTarget(), { paused: true })

  test('follows play and pause, counts picture-in-picture, and is false once it stops', () => {
    const video = fakeVideo()
    let pip = false
    const heard: boolean[] = []
    let ends = 0
    const stop = watchPlaying(
      video,
      on => heard.push(on),
      () => pip,
      () => ends++
    )
    video.paused = false
    video.dispatchEvent(new Event('play'))
    video.paused = true
    pip = true
    video.dispatchEvent(new Event('pause'))
    pip = false
    video.dispatchEvent(new Event('leavepictureinpicture'))
    video.dispatchEvent(new Event('ended'))
    stop()
    video.dispatchEvent(new Event('play'))
    video.dispatchEvent(new Event('ended'))
    expect(heard).toEqual([true, true, false, false, false])
    expect(ends).toBe(1)
  })
})

describe('which failures outlast a mount', () => {
  test('only bytes that cannot play, from a URL that is live', () => {
    const DECODE = 3
    const UNSUPPORTED = 4
    const NETWORK = 2
    const ABORTED = 1
    expect(remembersFailure(DECODE, true)).toBe(true)
    expect(remembersFailure(UNSUPPORTED, true)).toBe(true)
    expect(remembersFailure(NETWORK, true)).toBe(false)
    expect(remembersFailure(ABORTED, true)).toBe(false)
    expect(remembersFailure(0, true)).toBe(false)
    expect(remembersFailure(DECODE, false)).toBe(false)
  })

  test("a stored P2P file's URL is live from when it is made until it is dropped", async () => {
    const cache = new UrlCache(4, () => {})
    expect(cache.current('h')).toBeNull()
    await cache.use('h', () => Promise.resolve('blob:h'))
    expect(cache.current('h')).toBe('blob:h')
    cache.drop('h')
    expect(cache.current('h')).toBeNull()
  })
})

describe('mounting near the view', () => {
  test('waits a moment, so scrolling past loads nothing', () => {
    expect(NEAR_SETTLE_MS).toBe(200)
  })
})
