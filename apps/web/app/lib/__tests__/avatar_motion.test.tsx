import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PictureOver } from '../../components/avatar_picture'
import { UserAvatar } from '../../components/user_avatar'
import { animatedSizeFor, hasAnimation } from '../avatar_images'
import {
  ANIMATE_MODES,
  PLAYING_MAX,
  parseAnimateMode,
  playSlots,
  wantsToPlay,
} from '../avatar_motion'
import { pictured } from '../people'
import { useStore } from '../store'

describe('when an animated picture plays', () => {
  test('a stored value that is not a mode reads as the default', () => {
    for (const mode of ANIMATE_MODES) expect(parseAnimateMode(mode)).toBe(mode)
    for (const bad of [null, undefined, '', 'on', 1, {}])
      expect(parseAnimateMode(bad)).toBe('hover')
  })

  test('it plays when pointed at, always or never, and never with reduced motion', () => {
    expect(wantsToPlay('hover', true, true)).toBe(true)
    expect(wantsToPlay('hover', true, false)).toBe(false)
    expect(wantsToPlay('always', true, false)).toBe(true)
    expect(wantsToPlay('never', true, true)).toBe(false)
    for (const mode of ANIMATE_MODES) expect(wantsToPlay(mode, false, true)).toBe(false)
  })

  test('at most 8 play at once, and a place given back is taken again', () => {
    const slots = playSlots()
    const all = Array.from({ length: PLAYING_MAX + 1 }, () => ({}))
    expect(all.map(who => slots.take(who))).toEqual([...Array(PLAYING_MAX).fill(true), false])
    expect(slots.take(all[0])).toBe(true)
    expect(slots.count()).toBe(8)
    slots.give(all[3])
    expect(slots.take(all[PLAYING_MAX])).toBe(true)
    expect(slots.take(all[3])).toBe(false)
  })

  test('the id of a picture says whether it has an animation, and a drawing picks its size', () => {
    expect(hasAnimation(`${'0'.repeat(32)}-a`)).toBe(true)
    expect(hasAnimation('0'.repeat(32))).toBe(false)
    expect(hasAnimation(null)).toBe(false)
    expect(animatedSizeFor(32)).toBe(128)
    expect(animatedSizeFor(128)).toBe(128)
    expect(animatedSizeFor(160)).toBe(512)
  })
})

describe('the picture overlay', () => {
  test('an animation loads over the picture only while it plays', () => {
    const still = renderToStaticMarkup(
      <PictureOver src="/p/64" size={32}>
        <i />
      </PictureOver>
    )
    expect(still).not.toContain('data-avatar-animation')
    const playing = renderToStaticMarkup(
      <PictureOver src="/p/64" moving="/p/128/animated" size={32}>
        <i />
      </PictureOver>
    )
    expect(playing).toContain('data-avatar-animation="loading"')
    expect(playing).toContain('src="/p/128/animated"')
    expect(playing).toContain('src="/p/64"')
    expect(
      renderToStaticMarkup(
        <PictureOver src={null} moving="/p/128/animated" size={32}>
          <i />
        </PictureOver>
      )
    ).toBe('<i></i>')
  })
})

describe('an avatar with an animated picture', () => {
  const first = useStore.getInitialState()
  const saved = {
    settings: first.settings,
    streamer: first.streamer,
    animateMode: first.animateMode,
  }
  afterEach(() => void Object.assign(first, saved))
  const id = `${'0123456789abcdef'.repeat(2)}-a`
  const carol = pictured('carol', { kind: 'identicon', color: null, image: id }, 'own')

  test('the first frame shows and no animation is asked for until something points at it', () => {
    Object.assign(first, {
      settings: { ...saved.settings, profile_pictures: true, animated_profile_pictures: true },
      streamer: false,
      animateMode: 'hover',
    })
    const html = renderToStaticMarkup(<UserAvatar person={carol} size={32} />)
    expect(html).toContain(`/avatars/${id}/64"`)
    expect(html).not.toContain('/animated')
    expect(renderToStaticMarkup(<UserAvatar person={carol} size={32} animate />)).not.toContain(
      '/animated'
    )
  })
})
