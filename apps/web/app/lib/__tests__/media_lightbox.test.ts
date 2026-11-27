import { describe, expect, test } from 'bun:test'
import {
  atFit,
  clampView,
  collectGroupMedia,
  copiesAsImage,
  copyFrom,
  counterText,
  createShelf,
  detailText,
  doubleTap,
  FIT,
  fitScale,
  fitsIn,
  groupBounds,
  keepLive,
  MAX_ZOOM,
  moveTo,
  panBy,
  pinchView,
  menuStamp,
  quarter,
  readsPixels,
  rotateView,
  scaleOf,
  stepZoom,
  swipeMove,
  toggleZoom,
  turned,
  zoomAt,
  zoomStep,
  type ShelfScope,
  type Shelved,
  type View,
} from '../media_lightbox'
import type { GroupPlace } from '../message_groups'

// Group places from a row of letters: `F` starts a group, `-` continues the one above.
const placesOf = (row: string): GroupPlace[] =>
  [...row].map((c, i) => ({ first: c === 'F', last: row[i + 1] !== '-' }))

const img = (message: number | string, index = 0, key = `${message}:${index}`): Shelved => ({
  key,
  message,
  index,
})

const keys = (items: Shelved[]) => items.map(i => i.key)

const near = (n: number) => Math.round(n * 1e6) / 1e6

describe('the group around a row', () => {
  test('runs from its first row to the row before the next group', () => {
    const places = placesOf('F--F-F')
    expect(groupBounds(places, 0)).toEqual([0, 3])
    expect(groupBounds(places, 2)).toEqual([0, 3])
    expect(groupBounds(places, 4)).toEqual([3, 5])
    expect(groupBounds(places, 5)).toEqual([5, 6])
  })

  test('is the row alone where it has no place', () => {
    expect(groupBounds([], 2)).toEqual([2, 3])
  })
})

describe('what a click opens', () => {
  const ids = [10, 11, 12, 13, 14]
  const places = placesOf('F--F-')

  test("the group's images in message and attachment order, at the one clicked", () => {
    const shown = [img(12, 1), img(10), img(12, 0), img(11), img(13), img(14)]
    const { items, at } = collectGroupMedia(ids, places, shown, shown[3])
    expect(keys(items)).toEqual(['10:0', '11:0', '12:0', '12:1'])
    expect(at).toBe(1)
  })

  test('the next group opens on its own', () => {
    const shown = [img(10), img(13), img(14, 0), img(14, 1)]
    const { items, at } = collectGroupMedia(ids, places, shown, shown[3])
    expect(keys(items)).toEqual(['13:0', '14:0', '14:1'])
    expect(at).toBe(2)
  })

  test('an image whose message is not in the list opens alone', () => {
    const lone = img(99)
    expect(collectGroupMedia(ids, places, [img(10), lone], lone)).toEqual({
      items: [lone],
      at: 0,
    })
  })

  test('an attachment shown twice counts once, as the one clicked', () => {
    const twice = img(11, 0, 'again')
    const { items, at } = collectGroupMedia(ids, places, [img(10), img(11), twice], twice)
    expect(keys(items)).toEqual(['10:0', 'again'])
    expect(at).toBe(1)
  })

  test('P2P event ids work as message keys', () => {
    const shown = [img('ev-b'), img('ev-a', 1), img('ev-a', 0)]
    const { items, at } = collectGroupMedia(['ev-a', 'ev-b'], placesOf('F-'), shown, shown[0])
    expect(keys(items)).toEqual(['ev-a:0', 'ev-a:1', 'ev-b:0'])
    expect(at).toBe(2)
  })
})

describe('the open gallery follows what is on screen', () => {
  const all = ['a', 'b', 'c', 'd']
  const on =
    (...live: string[]) =>
    (k: string) =>
      live.includes(k)

  test('it stays on the shown image when others go', () => {
    expect(keepLive(all, 2, on('a', 'c', 'd'))).toEqual({ keys: ['a', 'c', 'd'], at: 1 })
  })

  test('when the shown image goes it shows the next, else the last', () => {
    expect(keepLive(all, 1, on('a', 'c', 'd'))).toEqual({ keys: ['a', 'c', 'd'], at: 1 })
    expect(keepLive(all, 3, on('a', 'b'))).toEqual({ keys: ['a', 'b'], at: 1 })
  })

  test('it closes when none are left', () => {
    expect(keepLive(all, 0, on())).toBeNull()
  })
})

test('moves stop at the ends of the gallery', () => {
  expect([moveTo(0, 3, 'prev'), moveTo(2, 3, 'next')]).toEqual([0, 2])
  expect([moveTo(0, 3, 'next'), moveTo(2, 3, 'prev')]).toEqual([1, 1])
  expect([moveTo(1, 3, 'first'), moveTo(1, 3, 'last')]).toEqual([0, 2])
  expect(moveTo(0, 0, 'next')).toBe(0)
})

test('the counter shows only for a gallery of more than one', () => {
  expect(counterText(1, 5)).toBe('2 / 5')
  expect(counterText(0, 1)).toBeNull()
})

describe('the shelf', () => {
  interface Item {
    src: string
  }
  const scope = (ids: string[], row: string): ShelfScope => ({
    rows: () => ({ ids, places: placesOf(row) }),
  })
  const entry = (key: string, message: string, s: ShelfScope | null, index = 0) => ({
    key,
    message,
    index,
    scope: s,
    item: { src: `blob:${key}` },
    act: () => key,
  })

  test('opens on the clicked image with the images of its group in its list', () => {
    const shelf = createShelf<Item, string>()
    const list = scope(['m1', 'm2', 'm3'], 'F-F')
    const other = scope(['m1', 'm2'], 'F-')
    shelf.put(entry('k2', 'm2', list))
    shelf.put(entry('k1', 'm1', list))
    shelf.put(entry('k3', 'm3', list))
    shelf.put(entry('x1', 'm1', other))
    expect(shelf.show('k2', 'button')).toBe(true)
    expect(shelf.state()).toEqual({
      keys: ['k1', 'k2'],
      at: 1,
      dir: 0,
      back: 'button',
      from: 'k2',
    })
    expect(shelf.entry('k2')?.act()).toBe('k2')
  })

  test('an image outside a list opens alone, and an unknown one not at all', () => {
    const shelf = createShelf<Item, string>()
    shelf.put(entry('k1', 'm1', null))
    shelf.put(entry('k2', 'm1', null, 1))
    expect(shelf.show('nope')).toBe(false)
    expect(shelf.state()).toBeNull()
    shelf.show('k2')
    expect(shelf.state()?.keys).toEqual(['k2'])
  })

  test('moves say their way, and stop at the ends', () => {
    const shelf = createShelf<Item, string>()
    const list = scope(['m1', 'm2'], 'F-')
    shelf.put(entry('k1', 'm1', list))
    shelf.put(entry('k2', 'm2', list))
    shelf.show('k1')
    shelf.go('next')
    expect([shelf.state()?.at, shelf.state()?.dir]).toEqual([1, 1])
    const version = shelf.version()
    shelf.go('next')
    expect(shelf.version()).toBe(version)
    shelf.go('first')
    expect([shelf.state()?.at, shelf.state()?.dir]).toEqual([0, -1])
  })

  test('an image leaving the screen leaves the gallery, which closes with the last', () => {
    const shelf = createShelf<Item, string>()
    const list = scope(['m1', 'm2', 'm3'], 'F--')
    for (const [k, m] of [
      ['k1', 'm1'],
      ['k2', 'm2'],
      ['k3', 'm3'],
    ])
      shelf.put(entry(k, m, list))
    shelf.show('k2', 'button')
    shelf.go('next')
    shelf.drop('k3')
    expect(shelf.state()).toEqual({
      keys: ['k1', 'k2'],
      at: 1,
      dir: 0,
      back: 'button',
      from: 'k2',
    })
    shelf.drop('k1')
    expect(shelf.state()).toEqual({ keys: ['k2'], at: 0, dir: 0, back: 'button', from: 'k2' })
    shelf.drop('k2')
    expect(shelf.state()).toBeNull()
  })

  test("an account's chat leaving the screen takes its images, and the gallery closes", () => {
    const shelf = createShelf<Item, string>()
    const list = scope(['m1', 'm2'], 'F-')
    shelf.put(entry('k1', 'm1', list))
    shelf.put(entry('k2', 'm2', list))
    shelf.show('k1')
    for (const k of ['k1', 'k2']) shelf.drop(k)
    expect(shelf.state()).toBeNull()
    expect(shelf.entry('k1')).toBeUndefined()
    shelf.put(entry('k1', 'm1', list))
    expect(shelf.state()).toBeNull()
  })

  test('an image of the group that comes on screen after it opened joins it, in order', () => {
    const shelf = createShelf<Item, string>()
    const ids = ['m1', 'm2', 'm3', 'm4']
    const list = scope(ids, 'F--F')
    shelf.put(entry('k2', 'm2', list))
    shelf.show('k2')
    expect(shelf.state()?.keys).toEqual(['k2'])
    shelf.put(entry('k3', 'm3', list))
    shelf.put(entry('k1', 'm1', list))
    shelf.put(entry('k4', 'm4', list))
    shelf.put(entry('x1', 'm1', scope(ids, 'F---')))
    expect([shelf.state()?.keys, shelf.state()?.at]).toEqual([['k1', 'k2', 'k3'], 1])
    shelf.close()
    shelf.put(entry('k5', 'm3', list, 1))
    expect(shelf.state()).toBeNull()
  })

  test('a spoiler or removed image that never comes on screen stays out of its group', () => {
    const shelf = createShelf<Item, string>()
    const list = scope(['m1', 'm2', 'm3'], 'F--')
    shelf.put(entry('k1', 'm1', list))
    shelf.put(entry('k3', 'm3', list))
    shelf.show('k1')
    expect(shelf.state()?.keys).toEqual(['k1', 'k3'])
  })

  test('tells its listeners of changes, not of an image put again as it was', () => {
    const shelf = createShelf<Item, string>()
    let told = 0
    const stop = shelf.subscribe(() => told++)
    shelf.put(entry('k1', 'm1', null))
    shelf.put(entry('k1', 'm1', null))
    expect(told).toBe(1)
    shelf.put({ ...entry('k1', 'm1', null), item: { src: 'blob:other' } })
    expect(told).toBe(2)
    shelf.show('k1')
    shelf.close()
    shelf.close()
    expect(told).toBe(4)
    shelf.drop('gone')
    stop()
    shelf.drop('k1')
    expect(told).toBe(4)
  })
})

describe('zoom, pan and turns', () => {
  const stage = { w: 832, h: 632 }
  const big = { w: 4000, h: 2000 }
  const small = { w: 200, h: 100 }

  test('fit shows the whole image inside the padding and never enlarges it', () => {
    expect(near(fitScale(stage, big, 0))).toBe(near(0.2))
    expect(fitScale(stage, small, 0)).toBe(1)
    expect(near(fitScale(stage, big, 1))).toBe(near(0.15))
    expect(turned(big, -1)).toEqual({ w: 2000, h: 4000 })
    expect(quarter(-1)).toBe(3)
    expect(fitScale(stage, { w: 0, h: 0 }, 0)).toBe(1)
  })

  test('steps go through the presets and the fit zoom, within their bounds', () => {
    expect(stepZoom(1, 1, 0.2)).toBe(1.25)
    expect(stepZoom(0.25, -1, 0.2)).toBe(0.2)
    expect(stepZoom(0.2, -1, 0.2)).toBe(0.2)
    expect(stepZoom(0.2, 1, 0.2)).toBe(0.25)
    expect(stepZoom(MAX_ZOOM, 1, 1)).toBe(MAX_ZOOM)
    expect(stepZoom(1.1, -1, 1)).toBe(1)
  })

  test('zooming keeps the point under the pointer in place', () => {
    const v = zoomAt(FIT, stage, big, 1, { x: 100, y: 50 })
    expect(v.scale).toBe(1)
    expect(near(v.x)).toBe(near(100 - 100 * 5))
    expect(near(v.y)).toBe(near(50 - 50 * 5))
    expect(atFit(v, stage, big)).toBe(false)
  })

  test('zooming back to fit fits again, centred', () => {
    const zoomed = zoomAt(FIT, stage, big, 2, { x: 100, y: 0 })
    expect(zoomAt(zoomed, stage, big, fitScale(stage, big, 0))).toEqual({ ...FIT })
    expect(zoomStep(zoomStep(FIT, stage, big, 1), stage, big, -1)).toEqual({ ...FIT })
  })

  test('a pan keeps the edges in reach, and an image smaller than the stage centred', () => {
    const zoomed: View = { scale: 1, x: 0, y: 0, turn: 0 }
    expect(panBy(zoomed, stage, big, 5000, -5000)).toEqual({
      ...zoomed,
      x: (4000 - 832) / 2,
      y: -(2000 - 632) / 2,
    })
    expect(panBy(FIT, stage, big, 40, 40)).toEqual(FIT)
    expect(clampView({ ...zoomed, x: 30 }, stage, small)).toEqual(zoomed)
  })

  test('a turn moves a quarter, centred, and its zoom stays within the new bounds', () => {
    const v = rotateView(rotateView(FIT, stage, big, -1), stage, big, -1)
    expect(v).toEqual({ scale: null, x: 0, y: 0, turn: -2 })
    expect(rotateView({ scale: 0.18, x: 3, y: 4, turn: 3 }, stage, big, 1)).toEqual({
      scale: 0.2,
      x: 0,
      y: 0,
      turn: 4,
    })
  })

  test('a double tap zooms in from fit and back out, keeping the turn', () => {
    const near = toggleZoom({ ...FIT, turn: 1 }, stage, big, { x: 0, y: 0 })
    expect([near.scale, near.turn]).toEqual([1, 1])
    expect(toggleZoom(near, stage, big, { x: 0, y: 0 })).toEqual({ ...FIT, turn: 1 })
    expect(toggleZoom(FIT, stage, small, { x: 0, y: 0 }).scale).toBe(2)
  })

  test('two fingers zoom by how far apart they move, and carry the image with them', () => {
    const at = { scale: 1, x: 0, y: 0, turn: 0 }
    const v = pinchView(
      at,
      stage,
      big,
      { mid: { x: 0, y: 0 }, dist: 100 },
      { mid: { x: 10, y: 0 }, dist: 200 }
    )
    expect(v).toEqual({ scale: 2, x: 10, y: 0, turn: 0 })
    expect(scaleOf(v, stage, big)).toBe(2)
  })

  test('below fit the image shows whole, so one finger swipes', () => {
    expect(fitsIn(FIT, stage, big)).toBe(true)
    expect(fitsIn({ ...FIT, scale: 0.1 }, stage, big)).toBe(true)
    expect(fitsIn({ ...FIT, scale: 1 }, stage, big)).toBe(false)
  })
})

test('a swipe goes left to the next image and right to the previous, past its distance', () => {
  expect(swipeMove(-80, 10)).toBe(1)
  expect(swipeMove(80, -10)).toBe(-1)
  expect(swipeMove(40, 0)).toBe(0)
  expect(swipeMove(-80, 70)).toBe(0)
})

test('two taps close in time and place make a double tap', () => {
  const tap = { t: 1000, x: 50, y: 50 }
  expect(doubleTap(null, tap)).toBe(false)
  expect(doubleTap(tap, { t: 1250, x: 60, y: 40 })).toBe(true)
  expect(doubleTap(tap, { t: 1400, x: 50, y: 50 })).toBe(false)
  expect(doubleTap(tap, { t: 1100, x: 100, y: 50 })).toBe(false)
})

describe('where a copy of an image comes from', () => {
  const page = 'https://chat.example/s/x/1/'
  const base = {
    src: 'blob:https://chat.example/1',
    name: 'a.png',
    page,
    shows: true,
    platform: true,
    bytes: false,
  }

  test("the page's own blobs and its own origin draw the image shown", () => {
    expect(copyFrom(base)).toBe('image')
    expect(copyFrom({ ...base, src: '/api/media/f1' })).toBe('image')
    expect(copyFrom({ ...base, src: 'https://chat.example/api/media/f1' })).toBe('image')
    expect(readsPixels('blob:https://elsewhere/1', page)).toBe(true)
  })

  test('another origin copies from fetched bytes, and without a way to fetch them not at all', () => {
    const away = { ...base, src: 'https://api.example/api/media/f1' }
    expect(readsPixels(away.src, page)).toBe(false)
    expect(copyFrom(away)).toBeNull()
    expect(copyFrom({ ...away, bytes: true })).toBe('bytes')
  })

  test('nothing copies before the image shows, where the platform can not, or for an SVG', () => {
    expect(copyFrom({ ...base, shows: false })).toBeNull()
    expect(copyFrom({ ...base, platform: false })).toBeNull()
    expect(copyFrom({ ...base, name: 'logo.svg' })).toBeNull()
  })
})

test('a menu change the viewer shows reaches it', () => {
  const menu = {
    name: 'a.png',
    verb: 'Download' as const,
    download: () => {},
    cancel: null,
    extra: [],
    link: null,
    remove: null,
  }
  const running = menuStamp({ ...menu, download: null, cancel: () => {} })
  expect(running).not.toBe(menuStamp(menu))
  expect(menuStamp({ ...menu, download: () => {} })).toBe(menuStamp(menu))
  const shelf = createShelf<{ src: string }, string>()
  let told = 0
  shelf.subscribe(() => told++)
  const entry = { key: 'k', message: 'm', index: 0, scope: null, item: { src: 'blob:a' } }
  shelf.put({ ...entry, act: () => 'a', stamp: menuStamp(menu) })
  shelf.put({ ...entry, act: () => 'b', stamp: menuStamp(menu) })
  expect(told).toBe(1)
  shelf.put({ ...entry, act: () => 'c', stamp: running })
  expect(told).toBe(2)
})

test('an SVG never copies as an image', () => {
  expect(copiesAsImage('a.png')).toBe(true)
  expect(copiesAsImage('logo.SVG')).toBe(false)
})

test('the bar reads size, file size and zoom, each when known', () => {
  expect(detailText({ w: 1280, h: 720 }, 211_600, 1)).toBe('1280×720 · 207 KB · 100%')
  expect(detailText(null, null, 0.254)).toBe('25%')
  expect(detailText(null, 2048, null)).toBe('2 KB')
  expect(detailText({ w: 0, h: 0 }, 900, 2)).toBe('900 B · 200%')
})
