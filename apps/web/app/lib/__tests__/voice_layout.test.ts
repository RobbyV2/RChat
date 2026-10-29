import { describe, expect, test } from 'bun:test'
import {
  autoFocus,
  callTone,
  screenKey,
  stageTiles,
  fitGrid,
  fmtDuration,
  keepFocus,
  linkQuality,
  maxColumns,
  spokenDuration,
  toggleFocus,
} from '../voice_layout'

describe('voice grid layout', () => {
  test('column caps follow the participant tiers', () => {
    expect([1, 2, 3, 4, 5, 9, 10, 25].map(maxColumns)).toEqual([1, 2, 2, 2, 3, 3, 4, 4])
  })

  test('one participant fills the stage at 16:9', () => {
    expect(fitGrid(1, 960, 540, 8)).toEqual({ cols: 1, width: 960, height: 540 })
    expect(fitGrid(1, 960, 270, 8)).toEqual({ cols: 1, width: 480, height: 270 })
  })

  test('two side by side on a wide stage, stacked on a tall phone', () => {
    expect(fitGrid(2, 1000, 500, 8).cols).toBe(2)
    expect(fitGrid(2, 360, 700, 8).cols).toBe(1)
  })

  test('three or four make a two by two grid', () => {
    const fit = fitGrid(4, 1000, 600, 8)
    expect(fit.cols).toBe(2)
    expect(fit.width).toBe(496)
    expect(fit.height).toBe(279)
  })

  test('three spread over two columns when that is nearly as large as one column', () => {
    expect(fitGrid(3, 696, 620, 8).cols).toBe(2)
    expect(fitGrid(3, 360, 900, 8).cols).toBe(1)
  })

  test('five to nine use three columns on a wide stage', () => {
    expect(fitGrid(7, 1200, 700, 8).cols).toBe(3)
  })

  test('ten or more never exceed four columns', () => {
    expect(fitGrid(16, 1600, 900, 8).cols).toBe(4)
    expect(fitGrid(30, 4000, 900, 8).cols).toBe(4)
  })

  test('tiles never shrink below the minimum width; the grid scrolls instead', () => {
    const fit = fitGrid(12, 360, 200, 8, 150)
    expect(fit.cols).toBe(2)
    expect(fit.width).toBe(176)
    expect(fit.height).toBe(99)
  })

  test('an unmeasured stage does not blow up', () => {
    expect(fitGrid(3, 0, 0).width).toBe(0)
    expect(fitGrid(0, 800, 450).cols).toBe(1)
  })
})

describe('focus state', () => {
  test('clicking a tile focuses it, clicking it again returns to the grid', () => {
    expect(toggleFocus(null, 'alice')).toBe('alice')
    expect(toggleFocus('alice', 'alice')).toBeNull()
    expect(toggleFocus('alice', 'bob')).toBe('bob')
  })

  test('focus is dropped when the participant leaves', () => {
    expect(keepFocus('bob', ['alice', 'bob'])).toBe('bob')
    expect(keepFocus('bob', ['alice'])).toBeNull()
    expect(keepFocus(null, ['alice'])).toBeNull()
  })
})

describe('link quality', () => {
  test('any failure is bad, any pending link is connecting, otherwise good', () => {
    expect(linkQuality([])).toBe('good')
    expect(linkQuality(['connected', 'connected'])).toBe('good')
    expect(linkQuality(['connected', 'connecting'])).toBe('connecting')
    expect(linkQuality(['new'])).toBe('connecting')
    expect(linkQuality(['connecting', 'disconnected'])).toBe('bad')
    expect(linkQuality(['failed'])).toBe('bad')
  })
})

describe('call log', () => {
  const log = (answered: number | null, ended: number | null, outcome: string | null) => ({
    from: 'alice',
    answered_at: answered,
    ended_at: ended,
    outcome: outcome as 'missed' | 'declined' | 'completed' | null,
  })

  test('tones', () => {
    expect(callTone(log(null, null, null))).toBe('ringing')
    expect(callTone(log(10, null, null))).toBe('active')
    expect(callTone(log(10, 70, 'completed'))).toBe('ended')
    expect(callTone(log(null, 30, 'declined'))).toBe('declined')
    expect(callTone(log(null, 30, 'missed'))).toBe('missed')
    expect(callTone(log(null, 30, 'completed'))).toBe('missed')
  })

  test('durations', () => {
    expect(fmtDuration(5)).toBe('0:05')
    expect(fmtDuration(3725)).toBe('1:02:05')
    expect(spokenDuration(12)).toBe('a few seconds')
    expect(spokenDuration(60)).toBe('1 minute')
    expect(spokenDuration(150)).toBe('2 minutes')
    expect(spokenDuration(3600)).toBe('1 hour')
    expect(spokenDuration(3720)).toBe('1 hour 2 minutes')
  })
})

describe('screen tiles', () => {
  const tiles = (sharing: string[]) =>
    stageTiles(['alice', 'bob', 'carol'], u => (sharing.includes(u) ? screenKey(u) : null))

  test('a share is a tile of its own ahead of the people', () => {
    expect(tiles([])).toEqual(['alice', 'bob', 'carol'])
    expect(tiles(['bob'])).toEqual(['bob:screen', 'alice', 'bob', 'carol'])
    expect(tiles(['carol', 'alice'])).toEqual([
      'alice:screen',
      'carol:screen',
      'alice',
      'bob',
      'carol',
    ])
  })
})

describe('auto-focus', () => {
  test('a new share takes the focus once', () => {
    const first = autoFocus(new Set(), [{ key: 'bob:screen', id: 'r1', own: false }])
    expect(first.focus).toBe('bob:screen')
    const again = autoFocus(first.seen, [{ key: 'bob:screen', id: 'r1', own: false }])
    expect(again.focus).toBe(null)
    expect(again.seen).toBe(first.seen)
  })

  test('the newest of several fresh shares wins, and a restarted share is new', () => {
    const both = autoFocus(new Set(), [
      { key: 'alice:screen', id: 'r1', own: false },
      { key: 'bob:screen', id: 'r2', own: false },
    ])
    expect(both.focus).toBe('bob:screen')
    expect(autoFocus(both.seen, []).focus).toBe(null)
    expect(autoFocus(both.seen, [{ key: 'bob:screen', id: 'r3', own: false }]).focus).toBe(
      'bob:screen'
    )
  })

  test('a share that ended and is seen again does not take the focus', () => {
    const one = autoFocus(new Set(), [{ key: 'bob:screen', id: 'r1', own: false }])
    const gone = autoFocus(one.seen, [])
    expect(autoFocus(gone.seen, [{ key: 'bob:screen', id: 'r1', own: false }]).focus).toBe(null)
  })

  test('your own share never takes the focus, but a share that starts while you share does', () => {
    const mine = { key: 'alice:screen', id: 'r1', own: true }
    const alone = autoFocus(new Set(), [mine])
    expect(alone.focus).toBe(null)
    const joined = autoFocus(alone.seen, [mine, { key: 'bob:screen', id: 'r2', own: false }])
    expect(joined.focus).toBe('bob:screen')
    expect(autoFocus(joined.seen, [mine, { key: 'bob:screen', id: 'r2', own: false }]).focus).toBe(
      null
    )
  })
})
