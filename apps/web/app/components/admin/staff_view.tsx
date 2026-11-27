'use client'

import { useState } from 'react'
import { STAFF_REASON_MAX, STAFF_VIEW_MINUTES } from '../../lib/staff_view'
import { useStore } from '../../lib/store'
import { ReAuthPrompt } from '../backup_phrase/reauth_prompt'
import { useSignInLinks } from '../sso/sign_in_methods'
import { Dialog, fieldCls } from '../ui'

// Asks the site admin to confirm before a channel their own membership does not open is shown.
export default function StaffViewPrompt() {
  const channel = useStore(s => (s.me?.is_site_admin ? s.staffAsk : null))
  return channel === null ? null : <Confirm key={channel} channel={channel} />
}

function Confirm({ channel }: { channel: number }) {
  const name = useStore(s => {
    for (const server of Object.values(s.servers)) {
      const found = server.channels.find(c => c.id === channel)
      if (found) return found.name
    }
    return null
  })
  const confirm = useStore(s => s.confirmStaffView)
  const close = useStore(s => s.closeStaffAsk)
  const { links } = useSignInLinks()
  const [reason, setReason] = useState('')
  return (
    <Dialog title="Open this channel?" compact layer="confirm" onClose={close}>
      <p className="text-sm text-on-surface-variant">
        Your membership does not open{' '}
        {name === null ? 'this channel' : <span className="streamer">#{name}</span>}. Confirm to
        open it for {STAFF_VIEW_MINUTES} minutes. This is added to the audit log.
      </p>
      <input
        value={reason}
        onChange={e => setReason(e.target.value)}
        maxLength={STAFF_REASON_MAX}
        placeholder="Reason (optional)"
        aria-label="Reason"
        className={`${fieldCls} my-4 w-full`}
      />
      <ReAuthPrompt
        purpose="staff_view"
        context={String(channel)}
        links={links ?? []}
        onBody={reauth => confirm(reauth, reason)}
      />
    </Dialog>
  )
}
