import { avatarUrlOf } from './asks'
import { sizeFor } from './avatar_images'
import { picturesShown, type AvatarView } from './avatar_setting'
import { useAccount } from './client/react'
import { useStore } from './store'

// How this device draws avatars in the account on screen.
export function useAvatarView(): AvatarView {
  const streamer = useStore(s => s.streamer)
  const served = useStore(s => s.settings.profile_pictures)
  const mode = useStore(s => s.avatarMode)
  return { mode, streamer, served }
}

// The address of an account's uploaded picture for a drawing of `size` CSS pixels; null when
// this device draws no picture for it.
export function useAccountPicture(image: string | null, size: number, view: AvatarView) {
  const account = useAccount()
  return image && picturesShown(view) ? avatarUrlOf(account, image, sizeFor(size, 2)) : null
}
