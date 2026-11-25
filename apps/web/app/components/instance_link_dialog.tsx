'use client'

import { useState, useSyncExternalStore } from 'react'
import { AccountProvider, useStore } from '../lib/client/react'
import { client } from '../lib/client/client'
import type { InstanceLinkDialog } from '../lib/client/instance_links'
import { AddInstanceFlow } from './add_instance'
import { Dialog, fieldCls, filledBtn, textBtn } from './ui'

function Choose({ dialog, close }: { dialog: InstanceLinkDialog; close: () => void }) {
  const streamer = useStore(s => s.streamer)
  const [user, setUser] = useState(dialog.selected ?? '')
  const [remember, setRemember] = useState(false)
  const host = new URL(dialog.target.origin).host
  return (
    <Dialog title="Choose an account" compact onClose={close}>
      <label className="flex flex-col gap-2">
        Open this link as
        <select autoFocus value={user} className={fieldCls} onChange={e => setUser(e.target.value)}>
          {dialog.users.map((name, index) => (
            <option key={name} value={name}>
              {streamer ? `Account ${index + 1}` : `${name} · ${host}`}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-4 flex items-center gap-2">
        <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
        {streamer
          ? 'Remember my account for matching links'
          : `Always use this account for links to ${host}`}
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <button className={textBtn} onClick={close}>
          Cancel
        </button>
        <button className={filledBtn} onClick={() => dialog.accept(user, remember)}>
          Open
        </button>
      </div>
    </Dialog>
  )
}
function Present() {
  const dialog = useStore(s => s.activeDialog)
  const close = useStore(s => s.closeDialog)
  if (dialog?.kind !== 'instance_link') return null
  if (dialog.selected)
    return (
      <Choose
        key={JSON.stringify([dialog.target, dialog.selected, dialog.users])}
        dialog={dialog}
        close={close}
      />
    )
  return (
    <Dialog full title="Open instance link" onClose={close}>
      <AddInstanceFlow
        key={dialog.target.origin}
        initialOrigin={dialog.target.origin}
        providerBack={dialog.target.path}
        initialUsername={dialog.username}
        linkTarget
        onDone={a => dialog.accept(a)}
        onCancel={close}
      />
    </Dialog>
  )
}
export default function InstanceLinkPresenter() {
  const owner = useSyncExternalStore(
    client.subscribe,
    () => (client.live().length ? client.shown() : null),
    () => null
  )
  if (!owner) return null
  return (
    <AccountProvider session={owner}>
      <Present key={owner.renderKey} />
    </AccountProvider>
  )
}
