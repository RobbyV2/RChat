'use client'

import { useState, useSyncExternalStore } from 'react'
import { AccountProvider, useStore } from '../lib/client/react'
import { client } from '../lib/client/client'
import type { InstanceLinkDialog } from '../lib/client/instance_links'
import { AddInstanceFlow } from './add_instance'
import { Button } from './controls'
import { useNameLabels } from './name'
import { accountLabel, instanceAddress, labelWith } from '../lib/names'
import { Row, Stack } from './layout'
import { Dialog, fieldCls } from './ui'

function Choose({ dialog, close }: { dialog: InstanceLinkDialog; close: () => void }) {
  const label = useNameLabels()
  const [user, setUser] = useState(dialog.selected ?? '')
  const [remember, setRemember] = useState(false)
  const host = new URL(dialog.target.origin).host
  return (
    <Dialog title="Choose an account" compact onClose={close}>
      <Stack gap="lg">
        <Stack as="label" gap="sm">
          Open this link as
          <select
            autoFocus
            value={user}
            className={fieldCls}
            onChange={e => setUser(e.target.value)}
          >
            {dialog.users.map((name, index) => (
              <option key={name} value={name}>
                {label.line(
                  `Account ${index + 1}`,
                  () => labelWith`${label(accountLabel(name))} · ${label(instanceAddress(host))}`
                )}
              </option>
            ))}
          </select>
        </Stack>
        <Row as="label" gap="sm">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
          {label.line(
            'Remember my account for matching links',
            () => labelWith`Always use this account for links to ${label(instanceAddress(host))}`
          )}
        </Row>
        <Row gap="sm" justify="end">
          <Button size="md" onClick={close}>
            Cancel
          </Button>
          <Button variant="filled" size="md" onClick={() => dialog.accept(user, remember)}>
            Open
          </Button>
        </Row>
      </Stack>
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
