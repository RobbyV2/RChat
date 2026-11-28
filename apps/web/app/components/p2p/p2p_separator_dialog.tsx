'use client'

import { useEffect } from 'react'
import { useP2pApp, useP2p, withP2pIdentity } from '../../lib/client/p2p_react'
import { ownsP2pServer } from '../../lib/p2p/server/types'
import { SeparatorForm } from '../channel_separator'

// A P2P room's separator form: a new one at the end of a list, or one to edit.
function P2pSeparatorDialogBody({
  room,
  id,
  cat,
}: {
  room: string
  id?: string
  cat?: string | null
}) {
  const { p2p, p2pServer } = useP2pApp()!
  const v = useP2p(s => s.servers[room])
  const own = useP2p(s => ownsP2pServer(v, s.me))
  const sep = id === undefined ? null : v?.separators.find(x => x.id === id)
  const gone = !v || sep === undefined
  useEffect(() => {
    if (gone) p2p.closeDialog()
  }, [gone, p2p])
  if (!v || sep === undefined) return null
  return (
    <SeparatorForm
      editing={sep !== null}
      initial={sep ?? { label: '', style: 'dots' }}
      own={own}
      onClose={p2p.closeDialog}
      onSave={(label, style) =>
        void (sep
          ? p2pServer.editSeparator(room, sep.id, { label, style })
          : p2pServer.createSeparator(room, label, style, cat ?? null))
      }
    />
  )
}

export const P2pSeparatorDialog = withP2pIdentity(P2pSeparatorDialogBody)
