import { afterEach, describe, expect, test } from 'bun:test'
import { applyMotion, stopMotion, type Load } from '../motion/host'
import { MOTION_PERMISSION, MOTION_POINTS } from '../motion/names'
import { look, plays, playsOn, playsOnly, reorders, still } from '../motion/play'
import { ANIM_DEFAULT, type AnimPrefs } from '../motion/setting'
import { blurringNow, liveNow, playerNow, setLive, watchLive, type Player } from '../motion/wire'

const ON: AnimPrefs = { ...ANIM_DEFAULT, on: true, motion: 'always' }
const node = () => ({}) as Element

const recorder = () => {
  const calls: unknown[][] = []
  const player: Player = {
    enter: (el, slot) => void calls.push(['enter', el, slot]),
    leave: (el, slot) => void calls.push(['leave', el, slot]),
    change: (el, slot, key) => void calls.push(['change', el, slot, key]),
    list: (scope, items) => {
      calls.push(['list', scope, items])
      return () => void calls.push(['unlist', scope])
    },
    stop: () => void calls.push(['stop']),
  }
  return { calls, player }
}

const loader = () => {
  const started: unknown[] = []
  const rec = recorder()
  let loads = 0
  const load: Load = async () => {
    loads++
    return {
      start: config => {
        started.push(config)
        return rec.player
      },
    }
  }
  return { load, started, rec, loads: () => loads }
}

afterEach(stopMotion)

describe('the engine is there only while animations are on', () => {
  test('off loads nothing and leaves no player', async () => {
    const l = loader()
    await applyMotion(ANIM_DEFAULT, false, l.load)
    await applyMotion({ ...ON, motion: 'device' }, true, l.load)
    expect(l.loads()).toBe(0)
    expect(playerNow()).toBeNull()
  })

  test('on loads it and starts it with the style and choices', async () => {
    const l = loader()
    await applyMotion({ ...ON, style: 'custom', custom: { dialog: 'off' } }, false, l.load)
    expect(l.started).toEqual([{ style: 'custom', custom: { dialog: 'off' }, reduced: false }])
    expect(playerNow()).toBe(l.rec.player)
  })

  test('Motion at Reduced starts it reduced', async () => {
    const l = loader()
    await applyMotion({ ...ON, motion: 'still' }, false, l.load)
    expect(l.started).toEqual([{ style: 'subtle', custom: {}, reduced: true }])
  })

  test('turning it off stops the player and clears what plays', async () => {
    const l = loader()
    await applyMotion(ON, false, l.load)
    setLive(new Set(['dialog']))
    await applyMotion({ ...ON, on: false }, false, l.load)
    expect(l.rec.calls).toEqual([['stop']])
    expect(playerNow()).toBeNull()
    expect(liveNow().size).toBe(0)
    expect(blurringNow().size).toBe(0)
  })

  test('a setting that changed while the engine loaded wins', async () => {
    const l = loader()
    const first = applyMotion(ON, false, l.load)
    const second = applyMotion(ANIM_DEFAULT, false, l.load)
    await Promise.all([first, second])
    expect(l.started).toEqual([])
    expect(playerNow()).toBeNull()
  })

  test('a new setting stops the running player before the next one starts', async () => {
    const a = loader()
    await applyMotion(ON, false, a.load)
    const order: string[] = []
    const next = recorder()
    const load: Load = async () => ({
      start: () => {
        order.push(`start after ${a.rec.calls.length} stop`)
        return next.player
      },
    })
    await applyMotion({ ...ON, style: 'lively' }, false, load)
    expect(a.rec.calls).toEqual([['stop']])
    expect(order).toEqual(['start after 1 stop'])
    expect(playerNow()).toBe(next.player)
    expect(next.calls).toEqual([])
  })
})

describe('naming a slot', () => {
  test('with animations off a ref does nothing and asks for no cleanup', () => {
    expect(plays('dialog')(node())).toBeUndefined()
    expect(playsOn('reaction.count', 2)(node())).toBeUndefined()
  })

  test('a ref is one function per slot, and per slot and key', () => {
    expect(plays('dialog')).toBe(plays('dialog'))
    expect(plays('dialog')).not.toBe(plays('sheet'))
    expect(playsOn('reaction.count', 2)).toBe(playsOn('reaction.count', 2))
    expect(playsOn('reaction.count', 2)).not.toBe(playsOn('reaction.count', '2'))
    expect(playsOn('reaction.count', 2)).not.toBe(playsOn('reaction.count', 3))
  })

  test('an element enters as it mounts and leaves through the cleanup', async () => {
    const l = loader()
    await applyMotion(ON, false, l.load)
    const el = node()
    const cleanup = plays('toast')(el)
    expect(l.rec.calls).toEqual([['enter', el, 'toast']])
    expect(plays('toast')(null)).toBeUndefined()
    if (typeof cleanup !== 'function') throw new Error('no cleanup')
    cleanup()
    expect(l.rec.calls[1]).toEqual(['leave', el, 'toast'])
  })

  test('a keyed ref hands the element and its key over', async () => {
    const l = loader()
    await applyMotion(ON, false, l.load)
    const el = node()
    playsOn('lightbox.slide', 4)(el)
    playsOn('lightbox.slide', 4)(null)
    expect(l.rec.calls).toEqual([['change', el, 'lightbox.slide', 4]])
  })

  test('the style sheet marks are constants', () => {
    expect(look('press')).toEqual({ 'data-motion': 'press' })
    expect(look('press', 'hover')).toEqual({ 'data-motion': 'press hover' })
    expect(look('press', 'hover')).toBe(look('press', 'hover'))
    expect(still).toEqual({ 'data-motion-none': '' })
    expect(playsOnly('call.tile')).toEqual({ 'data-motion-only': 'call.tile' })
    expect(playsOnly('call.tile')).toBe(playsOnly('call.tile'))
  })

  test('what plays is told to whoever watches', () => {
    let told = 0
    const stop = watchLive(() => void told++)
    setLive(new Set(['dialog']), new Set())
    expect(liveNow().has('dialog')).toBe(true)
    expect(blurringNow().has('dialog')).toBe(false)
    stop()
    setLive(null)
    expect(told).toBe(1)
  })
})

describe('plugin extension points', () => {
  test('are registered under their names and permission', () => {
    expect(MOTION_POINTS).toEqual({
      animations: 'motion.animations@1',
      slots: 'motion.slots@1',
    })
    expect(MOTION_PERMISSION).toBe('ui:motion')
  })
})

describe('a list whose items glide', () => {
  test('is given to the player that runs, and taken back as it goes', async () => {
    const l = loader()
    await applyMotion(ON, false, l.load)
    const scope = node()
    const off = reorders(scope, '[data-item]')
    expect(l.rec.calls).toEqual([['list', scope, '[data-item]']])
    off()
    off()
    expect(l.rec.calls).toEqual([
      ['list', scope, '[data-item]'],
      ['unlist', scope],
    ])
  })

  test('one that was there before animations came on is given to the player as it starts', async () => {
    const scope = node()
    const gone = node()
    const off = reorders(scope, '[data-item]')
    reorders(gone, '[data-item]')()
    const l = loader()
    await applyMotion(ON, false, l.load)
    expect(l.rec.calls).toEqual([['list', scope, '[data-item]']])
    stopMotion()
    off()
    expect(l.rec.calls).toEqual([['list', scope, '[data-item]'], ['stop']])
  })
})
