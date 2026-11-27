'use client'

import { useState } from 'react'
import {
  BAN_DURATIONS,
  BAN_REASON_MAX,
  HOSTED_BAN,
  HOSTED_BAN_NOTE,
  PURGE_ALL_NOTE,
  cleanReason,
  fitBan,
  purgeChoices,
  purgeLabel,
  type BanChoice,
} from '../lib/durations'
import { useStore } from '../lib/store'
import type { BanRequest } from '../lib/store_types'
import type { UserRef } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { Dialog, fieldCls, filledDangerBtn, textBtn } from './ui'
import { NameWithUsername } from './display_name'
import { useShown } from './shown_user'

// The hosted adapter: a ban of an account from a server through the instance.
export const hostedBanRequest = (
  server: string,
  user: UserRef,
  ban: (server: string, username: string, choice: BanChoice) => Promise<boolean>
): BanRequest => ({
  title: 'Ban from Server',
  name: user.display_name,
  user,
  note: HOSTED_BAN_NOTE,
  support: HOSTED_BAN,
  run: choice => ban(server, user.username, choice),
})

// Shows the ban dialog of either side: a hosted ban by server and account, a P2P ban by the
// request its room built.
export default function BanDialogHost() {
  const dialog = useStore(s => s.activeDialog)
  const close = useStore(s => s.closeDialog)
  if (dialog?.kind === 'ban')
    return (
      <HostedBan
        key={`${dialog.server}\n${dialog.user.username}`}
        server={dialog.server}
        account={dialog.user}
        onClose={close}
      />
    )
  return dialog?.kind === 'ban_request' ? (
    <BanDialog request={dialog.request} onClose={close} />
  ) : null
}

// A hosted ban names the member as the server shows them.
function HostedBan({
  server,
  account,
  onClose,
}: {
  server: string
  account: UserRef
  onClose: () => void
}) {
  const user = useShown(account, server)
  const banMember = useStore(s => s.banMember)
  return <BanDialog request={hostedBanRequest(server, user, banMember)} onClose={onClose} />
}

const chip = (on: boolean) =>
  `rounded-full border px-3 py-1.5 text-sm ${
    on
      ? 'border-primary bg-primary-container text-on-primary-container'
      : 'border-outline text-on-surface hover:bg-surface-container-highest'
  }`

const heading = 'mt-4 text-xs font-medium tracking-wide text-on-surface-variant uppercase'

function Chips<T>({
  label,
  options,
  value,
  onPick,
}: {
  label: string
  options: { label: string; value: T }[]
  value: T
  onPick: (value: T) => void
}) {
  return (
    <>
      <p className={heading}>{label}</p>
      <div role="radiogroup" aria-label={label} className="mt-2 flex flex-wrap gap-2">
        {options.map(o => (
          <button
            key={o.label}
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onPick(o.value)}
            className={chip(value === o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </>
  )
}

// The ban dialog of hosted servers and P2P rooms: how long, why, and how far back the member's
// messages go. The request says what its side supports and bans.
export function BanDialog({ request, onClose }: { request: BanRequest; onClose: () => void }) {
  const { title, name, user, note, support, run } = request
  const [seconds, setSeconds] = useState<number | null>(null)
  const [purge, setPurge] = useState(0)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const windows = purgeChoices(support.purge)
  const submit = async () => {
    if (busy) return
    setBusy(true)
    const choice: BanChoice = { seconds, reason: cleanReason(reason), purgeHours: purge }
    const ok = await run(fitBan(choice, support))
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="flex items-center gap-3">
        {user && (
          <UserAvatar
            username={user.username}
            avatarKind={user.avatar_kind}
            avatarColor={user.avatar_color}
            size={36}
          />
        )}
        <div className="min-w-0">
          <p className="streamer truncate text-sm font-medium text-on-surface">
            {user ? <NameWithUsername user={user} /> : name}
          </p>
          {user && (
            <p className="streamer truncate text-xs text-on-surface-variant">@{user.username}</p>
          )}
        </div>
      </div>
      <p className="mt-3 text-sm text-on-surface-variant">{note}</p>
      {support.timed && (
        <Chips label="Duration" options={BAN_DURATIONS} value={seconds} onPick={setSeconds} />
      )}
      {windows.length > 0 && (
        <Chips
          label={purgeLabel(support.purge)}
          options={windows}
          value={purge}
          onPick={setPurge}
        />
      )}
      {support.purge === 'all' && purge !== 0 && (
        <p className="mt-2 text-xs text-on-surface-variant">{PURGE_ALL_NOTE}</p>
      )}
      <label className={`${heading} block`}>
        Reason
        <input
          value={reason}
          maxLength={BAN_REASON_MAX}
          onChange={e => setReason(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') void submit()
          }}
          placeholder="Optional, shown to moderators"
          className={`${fieldCls} mt-1.5 w-full text-on-surface normal-case tracking-normal`}
        />
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={textBtn}>
          Cancel
        </button>
        <button
          disabled={busy}
          onClick={() => void submit()}
          className={`${filledDangerBtn} disabled:opacity-40`}
        >
          Ban
        </button>
      </div>
    </Dialog>
  )
}
