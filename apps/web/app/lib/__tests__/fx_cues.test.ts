import { describe, expect, test } from 'bun:test'
import {
  createGate,
  decideMessage,
  decideReaction,
  matchMessage,
  MESSAGE_GATE,
  REACTION_GATE,
  p2pLive,
  replayEffect,
  type MessageEvent,
  type ReactionEvent,
} from '../fx/cues'
import { cueSegments } from '../fx/md_text'
import { viewProse } from './fx_view_reader'
import { spoilerParts } from '../spoilers'

const fx = (text: string, dm = false) => matchMessage(text, dm)?.effect ?? null

describe('message phrases', () => {
  test("the owner's list", () => {
    expect(fx('happy birthday!!')).toBe('balloons')
    expect(fx('Congrats on the launch')).toBe('confetti')
    expect(fx('congratulations')).toBe('confetti')
    expect(fx('gg')).toBe('trophy')
    expect(fx('HAPPY NEW YEAR')).toBe('fireworks')
    expect(fx('let it snow')).toBe('snow')
  })
  test('stretched letters and punctuation still match; shorter words never do', () => {
    expect(fx('happpppy birthdayyyy')).toBe('balloons')
    expect(fx('GGGG')).toBe('trophy')
    expect(fx('gg wp')).toBe('trophy')
    expect(fx('e.g. this')).toBeNull()
    expect(fx('g')).toBeNull()
    expect(fx('eggs')).toBeNull()
    expect(fx('god game')).toBeNull()
  })
  test('other languages, with or without accents', () => {
    expect(fx('¡Feliz cumpleaños!')).toBe('balloons')
    expect(fx('feliz cumpleanos')).toBe('balloons')
    expect(fx('Joyeux anniversaire')).toBe('balloons')
    expect(fx('С днём рождения')).toBe('balloons')
    expect(fx('お誕生日おめでとう！')).toBe('balloons')
    expect(fx('新年快乐')).toBe('fireworks')
    expect(fx('恭喜发财')).toBe('season:lunar_new_year')
    expect(fx('Herzlichen Glückwunsch')).toBe('confetti')
  })
  test('seasonal greetings ask for that season', () => {
    expect(fx('Merry Christmas everyone')).toBe('season:christmas')
    expect(fx('happy halloween')).toBe('season:halloween')
    expect(fx('Eid Mubarak')).toBe('season:eid_al_fitr')
    expect(fx("happy valentine's day")).toBe('season:valentines')
    expect(fx('happy lunar new year')).toBe('season:lunar_new_year')
  })
  test('the earliest hit wins', () => {
    expect(fx('gg and congrats')).toBe('trophy')
    expect(fx('congrats and gg')).toBe('confetti')
  })
  test('hearts only in DMs', () => {
    expect(fx('love you', true)).toBe('hearts')
    expect(fx('love you', false)).toBeNull()
  })
  test("it's live", () => {
    expect(fx("it's live!")).toBe('rocket')
  })
  test('emoji-only messages', () => {
    expect(fx('🎉')).toBe('confetti')
    expect(fx('🎉🥳')).toBe('confetti')
    expect(fx('🎂 🎈')).toBe('balloons')
    expect(fx('🎉🎂')).toBeNull()
    expect(fx('🎉🎉🎉🎉')).toBeNull()
    expect(fx('❄')).toBe('snow')
    expect(fx('||🎉||')).toBeNull()
    expect(fx('`🎉`')).toBeNull()
  })
})

describe('what never triggers', () => {
  test('code, quotes, spoilers, links and mentions', () => {
    expect(fx('`happy birthday`')).toBeNull()
    expect(fx('```\ncongrats\n```')).toBeNull()
    expect(fx('> happy birthday\nok')).toBeNull()
    expect(fx('||congrats||')).toBeNull()
    expect(fx('https://example.com/happy-birthday')).toBeNull()
    expect(fx('@congrats hi')).toBeNull()
    expect(fx('#gg')).toBeNull()
    expect(fx(':tada:')).toBeNull()
    expect(fx('[congrats](https://x.y)')).toBe('confetti')
  })
  test('long messages', () => {
    expect(fx('congrats ' + 'x'.repeat(600))).toBeNull()
  })
  test('the tree keeps plain text, one segment per block', () => {
    expect(cueSegments('hi `x` there')).toEqual(['hi  there'])
    expect(cueSegments('happy\n\nbirthday')).toEqual(['happy', 'birthday'])
    expect(fx('happy\n\nbirthday')).toBeNull()
  })
})

describe('message decisions', () => {
  const ev = (over: Partial<MessageEvent> = {}): MessageEvent => ({
    id: '1',
    scope: 'c1',
    text: 'congrats',
    dm: false,
    live: true,
    kind: 'user',
    blocked: false,
    placeOn: true,
    ...over,
  })
  test('only live user messages in places that allow it', () => {
    const g = () => createGate(MESSAGE_GATE.scopeMs, MESSAGE_GATE.globalMs)
    expect(decideMessage(ev(), g(), 0)).toBe('confetti')
    expect(decideMessage(ev({ live: false }), g(), 0)).toBeNull()
    expect(decideMessage(ev({ kind: 'webhook' }), g(), 0)).toBeNull()
    expect(decideMessage(ev({ kind: 'system' }), g(), 0)).toBeNull()
    expect(decideMessage(ev({ blocked: true }), g(), 0)).toBeNull()
    expect(decideMessage(ev({ placeOn: false }), g(), 0)).toBeNull()
  })
  test('once per message, once per scope per 10 s, once anywhere per 4 s', () => {
    const g = createGate(MESSAGE_GATE.scopeMs, MESSAGE_GATE.globalMs)
    expect(decideMessage(ev(), g, 0)).toBe('confetti')
    expect(decideMessage(ev(), g, 20_000)).toBeNull()
    expect(decideMessage(ev({ id: '2' }), g, 5_000)).toBeNull()
    expect(decideMessage(ev({ id: '3', scope: 'c2' }), g, 3_000)).toBeNull()
    expect(decideMessage(ev({ id: '4', scope: 'c2' }), g, 4_000)).toBe('confetti')
    expect(decideMessage(ev({ id: '5' }), g, 10_000)).toBe('confetti')
  })
  test('a storm of 1000 messages in 10 s gives at most 3 effects', () => {
    const g = createGate(MESSAGE_GATE.scopeMs, MESSAGE_GATE.globalMs)
    let n = 0
    for (let i = 0; i < 1000; i++)
      if (decideMessage(ev({ id: String(i), scope: `c${i % 7}` }), g, i * 10)) n++
    expect(n).toBeLessThanOrEqual(3)
  })
})

describe('reaction decisions', () => {
  const ev = (over: Partial<ReactionEvent> = {}): ReactionEvent => ({
    messageId: '9',
    scope: 'c1',
    emoji: '🎉',
    reactor: 'alice',
    count: 1,
    previous: 0,
    added: true,
    mine: true,
    reactorBlocked: false,
    byAutomation: false,
    onScreen: true,
    placeOn: true,
    ...over,
  })
  const g = () => createGate(REACTION_GATE.scopeMs, REACTION_GATE.globalMs)
  test('party reactions burst for the reactor', () => {
    expect(decideReaction(ev(), g(), 0)).toEqual({ kind: 'burst', effect: 'confetti' })
    expect(decideReaction(ev({ emoji: '🎂' }), g(), 0)).toEqual({
      kind: 'burst',
      effect: 'balloons',
    })
    expect(decideReaction(ev({ emoji: '👍' }), g(), 0)).toBeNull()
    expect(decideReaction(ev({ added: false }), g(), 0)).toBeNull()
  })
  test("and for anyone watching live: bob's 🎉 bursts for alice", () => {
    const bob = { mine: false, reactor: 'bob', count: 2, previous: 1 }
    expect(decideReaction(ev(bob), g(), 0)).toEqual({ kind: 'burst', effect: 'confetti' })
    expect(decideReaction(ev({ ...bob, onScreen: false }), g(), 0)).toBeNull()
    expect(decideReaction(ev({ ...bob, reactorBlocked: true }), g(), 0)).toBeNull()
    expect(decideReaction(ev({ ...bob, byAutomation: true }), g(), 0)).toBeNull()
    expect(decideReaction(ev({ ...bob, placeOn: false }), g(), 0)).toBeNull()
    expect(decideReaction(ev({ ...bob, emoji: '😂' }), g(), 0)).toBeNull()
  })
  test('a watcher sees each person once per message, and the gate holds a storm', () => {
    const gate = g()
    const by = (reactor: string, at: number) =>
      decideReaction(ev({ mine: false, reactor, count: null, previous: null }), gate, at)
    expect(by('bob', 0)).not.toBeNull()
    expect(by('bob', 10_000)).toBeNull()
    expect(by('carol', 1_000)).toBeNull()
    expect(by('dave', 3_000)).not.toBeNull()
    let n = 0
    const storm = g()
    for (let i = 0; i < 500; i++)
      if (
        decideReaction(
          ev({ mine: false, reactor: `u${i}`, count: null, previous: null }),
          storm,
          i * 20
        )
      )
        n++
    expect(n).toBeLessThanOrEqual(4)
  })
  test('round counts burst for watchers when crossed upward, once, and win over a party burst', () => {
    const gate = g()
    const other = (count: number, previous: number, at: number, emoji = '😂') =>
      decideReaction(ev({ mine: false, reactor: `r${at}`, emoji, count, previous }), gate, at)
    expect(other(9, 8, 0)).toBeNull()
    expect(other(10, 9, 0)).toEqual({ kind: 'round', emoji: '😂', count: 10 })
    expect(other(10, 9, 10_000)).toBeNull()
    expect(other(11, 10, 20_000)).toBeNull()
    expect(other(25, 24, 30_000)).toEqual({ kind: 'round', emoji: '😂', count: 25 })
    expect(other(10, 9, 40_000, '🎉')).toEqual({ kind: 'round', emoji: '🎉', count: 10 })
  })
  test('a jump across two thresholds bursts once, for the higher one', () => {
    expect(decideReaction(ev({ mine: false, count: 60, previous: 5 }), g(), 0)).toEqual({
      kind: 'round',
      emoji: '🎉',
      count: 50,
    })
  })
})

describe('the app parse decides what is prose', () => {
  test("the reviewer's cases", () => {
    // `spoilerParts` hides the whole text of this one: so must the cues.
    expect(
      spoilerParts('||a \\|| congrats||').every(p => p.spoiler || !/congrats/.test(p.text))
    ).toBe(true)
    expect(fx('||a \\|| congrats||')).toBeNull()
    expect(fx('~~~\ncongrats\n~~~')).toBeNull()
    expect(fx('    congrats')).toBeNull()
    expect(fx('hello\n\n    congrats')).toBeNull()
    expect(fx('- > congrats')).toBeNull()
    expect(fx('(@congrats)')).toBeNull()
    expect(fx('hi,@congrats')).toBeNull()
    // The view drops raw HTML tags and shows the words between them, so they count.
    expect(fx('<b>congrats</b>')).toBe('confetti')
    expect(fx('<!-- congrats -->')).toBeNull()
    expect(fx('![congrats](https://x.y/a.png)')).toBeNull()
    expect(fx('www.congrats.example')).toBeNull()
  })
  test('prose around those still counts', () => {
    expect(fx('- congrats on it')).toBe('confetti')
    expect(fx('# Happy birthday')).toBe('balloons')
    expect(fx('**congrats**')).toBe('confetti')
    expect(fx('||secret|| congrats')).toBe('confetti')
    expect(fx('`x` gg')).toBe('trophy')
  })
  test('property: a phrase that is only inside a hidden spoiler never cues', () => {
    const bits = ['a', ' ', '|', '\\|', '`', 'x', '\n', '>', '*', '||', 'b ', ' c']
    let rnd = 7
    const r = () => (rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    const pick = () => bits[Math.floor(r() * bits.length)]
    let checked = 0
    for (let i = 0; i < 3000; i++) {
      const pre = Array.from({ length: Math.floor(r() * 6) }, pick).join('')
      const mid = Array.from({ length: Math.floor(r() * 3) }, pick).join('')
      const post = Array.from({ length: Math.floor(r() * 6) }, pick).join('')
      const text = `${pre}||${mid}congrats${mid}||${post}`
      // Hidden by either reader: the previews' `spoilerParts`, or the view's tree.
      const visible = spoilerParts(text)
        .filter(p => !p.spoiler)
        .map(p => p.text)
        .join(' ')
      if (/congrats/.test(visible)) continue
      checked++
      expect([text, fx(text)]).toEqual([text, null])
    }
    expect(checked).toBeGreaterThan(1000)
  })
})

describe('replay and one meaning for "make it rain"', () => {
  test('replay ignores the gate', () => {
    const gate = createGate(MESSAGE_GATE.scopeMs, MESSAGE_GATE.globalMs)
    const m: MessageEvent = {
      id: '1',
      scope: 'c',
      text: 'congrats',
      dm: false,
      live: true,
      kind: 'user',
      blocked: false,
      placeOn: true,
    }
    expect(decideMessage(m, gate, 0)).toBe('confetti')
    expect(decideMessage(m, gate, 60_000)).toBeNull()
    expect(replayEffect('congrats', false)).toBe('confetti')
    expect(replayEffect('nothing here', false)).toBeNull()
  })
  test('"make it rain" is the season rain, and there is no money effect', () => {
    expect(fx('make it rain')).toBe('season_rain')
    expect(fx('💸')).toBeNull()
  })
  test('automation posts never cue', () => {
    const gate = createGate(MESSAGE_GATE.scopeMs, MESSAGE_GATE.globalMs)
    expect(
      decideMessage(
        {
          id: '2',
          scope: 'c',
          text: 'congrats',
          dm: false,
          live: true,
          kind: 'automation',
          blocked: false,
          placeOn: true,
        },
        gate,
        0
      )
    ).toBeNull()
  })
})

describe('cost', () => {
  test('messages without a cue skip the parse; a full parse stays small', () => {
    const plain = 'just talking about the weather and lunch plans for later today '.repeat(6)
    let t = performance.now()
    for (let i = 0; i < 20_000; i++) fx(plain)
    const cheap = (performance.now() - t) / 20_000
    t = performance.now()
    for (let i = 0; i < 2_000; i++) fx(`**well** done, congrats ${i} > not a quote`)
    const full = (performance.now() - t) / 2_000
    expect(cheap).toBeLessThan(0.1)
    expect(full).toBeLessThan(2)
  })
})

describe('P2P live', () => {
  test('push frames of an open room within 60 s', () => {
    expect(p2pLive('push', true, 1_000, 30_000)).toBe(true)
    expect(p2pLive('push', true, 1_000, 62_000)).toBe(false)
    expect(p2pLive('sync', true, 1_000, 1_000)).toBe(false)
    expect(p2pLive('history', true, 1_000, 1_000)).toBe(false)
    expect(p2pLive('push', false, 1_000, 1_000)).toBe(false)
  })
})

describe('one parse, hidden by source position', () => {
  test("the reviewer's leak: blanking first unclosed an HTML comment", () => {
    expect(fx('hi <!-- congrats ||-->|| there')).toBeNull()
    expect(viewProse('hi <!-- congrats ||-->|| there')).not.toContain('congrats')
  })
  test('markup crossing the markers: the fixed 0.4.0 view hides these, so cues never fire', () => {
    // Today's view shows them (the tracked 0.4.0 bug); the previews hide them.
    expect(fx('**||congrats**||')).toBeNull()
    expect(fx('||a *congrats|| c*')).toBeNull()
    expect(fx('*||congrats*||')).toBeNull()
  })
  test('well-formed nesting and prose around a spoiler', () => {
    expect(fx('||**congrats**||')).toBeNull()
    expect(fx('**||congrats||**')).toBeNull()
    expect(fx('**congrats** ||x||')).toBe('confetti')
    expect(fx('||x|| [congrats](https://a.b) ||y||')).toBe('confetti')
    expect(fx('a \\|| congrats')).toBe('confetti')
  })
  test('escapes keep a node whole: shown if none of it is hidden', () => {
    expect(fx('congrats \\*really\\*')).toBe('confetti')
    expect(fx('||congrats \\*really\\*||')).toBeNull()
  })
  test('property: a cue fires only on a phrase both readers show (60,000 cases)', () => {
    const bits = [
      'a',
      ' ',
      '|',
      '||',
      '\\|',
      '`',
      '```',
      'x',
      '\n',
      '\n\n',
      '>',
      '*',
      '**',
      '_',
      '~~',
      '<!--',
      '-->',
      '[',
      ']',
      '(',
      ')',
      '](u)',
      '<b>',
      '</b>',
      '    ',
      '- ',
      '#',
      ' c',
    ]
    let rnd = 11
    const r = () => (rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    const pick = () => bits[Math.floor(r() * bits.length)]
    let cued = 0
    for (let i = 0; i < 60_000; i++) {
      const pre = Array.from({ length: Math.floor(r() * 7) }, pick).join('')
      const post = Array.from({ length: Math.floor(r() * 7) }, pick).join('')
      const text = `${pre}congrats${post}`
      if (fx(text) !== 'confetti') continue
      cued++
      const previews = spoilerParts(text)
        .filter(p => !p.spoiler)
        .map(p => p.text)
        .join(' ')
      expect([text, /congrats/.test(previews)]).toEqual([text, true])
      expect([text, /congrats/.test(viewProse(text))]).toEqual([text, true])
    }
    expect(cued).toBeGreaterThan(10_000)
  }, 120_000)
})
