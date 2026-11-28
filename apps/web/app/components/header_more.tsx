'use client'

import { MoreVertical } from 'lucide-react'
import { openActionMenu, useHasMenu } from '../lib/actions/menu'
import type { Target } from '../lib/actions/types'
import { useAccount } from '../lib/client/react'
import { isUnsupported } from '../lib/place/feature'
import { pins as pinsFeature } from '../lib/place/pins'
import { useFeature } from '../lib/place/react'
import { threads as threadsFeature } from '../lib/place/threads'
import { useStore } from '../lib/store'
import { IconButton } from './controls'

export const HEADER_MORE = 'header-more'

// The header actions that fold into one menu when the header is narrow: selection (`scope`, the
// header's conversation), the pins and threads of the place around it, and search.
export function HeaderMore({ scope, search }: { scope: string | null; search: boolean }) {
  const acct = useAccount()
  const pins = useFeature(pinsFeature)
  const threads = useFeature(threadsFeature)
  const target: Target = {
    kind: 'header',
    list: scope,
    search,
    pins: isUnsupported(pins) ? null : pins,
    threads: isUnsupported(threads) ? null : threads,
  }
  const open = useStore(s => s.contextMenu?.owner === HEADER_MORE)
  const has = useHasMenu(target)
  if (!has) return null
  return (
    <IconButton
      icon={MoreVertical}
      label="More"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={e => {
        const r = e.currentTarget.getBoundingClientRect()
        openActionMenu(r.right, r.bottom + 4, target, { owner: HEADER_MORE }, acct)
      }}
      size="lg"
      tone="inherit"
      place="@sm:hidden"
    />
  )
}
