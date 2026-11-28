import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react'
import { avatarAnimatedUrlOf, avatarUrlOf } from './asks'
import { animatedSizeFor, hasAnimation, sizeFor } from './avatar_images'
import { picturesShown, type AvatarView } from './avatar_setting'
import { pointedAt, slots, wantsToPlay, watchPointed } from './avatar_motion'
import { useAccount } from './client/react'
import { useMotionAllowed } from './motion/use_motion'
import { useStore } from './store'

// How this device draws avatars in the account on screen.
export function useAvatarView(): AvatarView {
  const streamer = useStore(s => s.streamer)
  const served = useStore(s => s.settings.profile_pictures)
  const mode = useStore(s => s.avatarMode)
  return { mode, streamer, served }
}

// The address of the animation of an account's or a hosted server's picture for a drawing of
// `size` CSS pixels; null when the picture has none or the site keeps none.
export function useAccountAnimation(image: string | null, size: number, view: AvatarView) {
  const account = useAccount()
  const kept = useStore(s => s.settings.animated_profile_pictures)
  return image && kept && hasAnimation(image) && picturesShown(view)
    ? avatarAnimatedUrlOf(account, image, animatedSizeFor(size, 1))
    : null
}

// The address of an account's uploaded picture for a drawing of `size` CSS pixels; null when
// this device draws no picture for it.
export function useAccountPicture(image: string | null, size: number, view: AvatarView) {
  const account = useAccount()
  return image && picturesShown(view) ? avatarUrlOf(account, image, sizeFor(size, 2)) : null
}

const watchNothing = () => () => {}

// Whether the animation of the picture in `box` plays now: it has one (`has`), this device
// plays animations, something points at it (the pointer over it or its row, its person
// speaking, or `animate`: an open profile, a speaker's tile), it is on screen, and one of the
// places among the pictures playing at once is free.
export function usePlays(box: RefObject<Element | null>, has: boolean, animate = false): boolean {
  const mode = useStore(s => s.animateMode)
  const moves = useMotionAllowed() === 'full'
  const watching = has && moves && mode === 'hover' && !animate
  const pointed = useSyncExternalStore(
    watching ? watchPointed : watchNothing,
    () => watching && pointedAt(box.current),
    () => false
  )
  const wants = has && wantsToPlay(mode, moves, animate || pointed)
  const [plays, setPlays] = useState(false)
  useEffect(() => {
    const node = box.current
    if (!wants || !node) return setPlays(false)
    const place = {}
    const settle = (seen: boolean) => {
      if (!seen) slots.give(place)
      setPlays(seen && slots.take(place))
    }
    const watch =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(entries => settle(entries.some(e => e.isIntersecting)))
    watch?.observe(node)
    if (!watch) settle(true)
    return () => {
      watch?.disconnect()
      slots.give(place)
    }
  }, [wants, box])
  return wants && plays
}
