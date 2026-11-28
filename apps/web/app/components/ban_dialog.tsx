'use client'

import { handleName, personName } from '../lib/names'
import { Name } from './name'
import { useState } from 'react'
import {
  BAN_DURATIONS,
  BAN_REASON_MAX,
  PURGE_ALL_NOTE,
  cleanReason,
  fitBan,
  purgeChoices,
  purgeLabel,
  type BanChoice,
} from '../lib/durations'
import { useStore } from '../lib/store'
import { moderationOf } from '../lib/place/moderation'
import { useLive, useWatch } from '../lib/place/react'
import type { ModerationTarget } from '../lib/store_types'
import { UserAvatar } from './user_avatar'
import { Button, Chip } from './controls'
import { Row, Stack } from './layout'
import { Dialog, fieldCls } from './ui'

// Shows the ban dialog for the member of a hosted server or a P2P room.
export default function BanDialogHost() {
  const dialog = useStore(s => s.activeDialog)
  const close = useStore(s => s.closeDialog)
  return dialog?.kind === 'ban' ? (
    <BanDialog
      key={`${dialog.place.id}\n${dialog.who}`}
      place={dialog.place}
      who={dialog.who}
      known={dialog.known}
      onClose={close}
    />
  ) : null
}

const heading = 'text-xs font-medium tracking-wide text-on-surface-variant uppercase'

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
    <Stack gap="sm">
      <p className={heading}>{label}</p>
      <Row role="radiogroup" aria-label={label} gap="sm" wrap>
        {options.map(o => (
          <Chip key={o.label} radio on={value === o.value} onClick={() => onPick(o.value)}>
            {o.label}
          </Chip>
        ))}
      </Row>
    </Stack>
  )
}

// The ban dialog of hosted servers and P2P rooms: how long, why, and how far back the member's
// messages go. The place says what its side supports and bans.
export function BanDialog({
  place,
  who,
  known,
  onClose,
}: ModerationTarget & { onClose: () => void }) {
  const { member, ban } = moderationOf(place)
  const { title, note } = ban
  const { name, user } = useWatch(() => member(who, known), [member, who, known])
  const support = useLive(ban.support)
  const [seconds, setSeconds] = useState<number | null>(null)
  const [purge, setPurge] = useState(0)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const windows = purgeChoices(support.purge)
  const submit = async () => {
    if (busy) return
    setBusy(true)
    const choice: BanChoice = { seconds, reason: cleanReason(reason), purgeHours: purge }
    const ok = await ban.run(who, fitBan(choice, support))
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Dialog title={title} onClose={onClose}>
      <Stack gap="lg">
        <Stack gap="md">
          <Row gap="md">
            {user && <UserAvatar person={user} size={36} />}
            <Stack gap="none" place="min-w-0">
              <Name
                as="p"
                of={user ? personName(user) : handleName(name)}
                withUsername
                look="truncate text-sm font-medium text-on-surface"
              />
              {user && (
                <Name
                  as="p"
                  of={handleName(user.username)}
                  before="@"
                  look="truncate text-xs text-on-surface-variant"
                />
              )}
            </Stack>
          </Row>
          <p className="text-sm text-on-surface-variant">{note}</p>
        </Stack>
        {support.timed && (
          <Chips label="Duration" options={BAN_DURATIONS} value={seconds} onPick={setSeconds} />
        )}
        {windows.length > 0 && (
          <Stack gap="sm">
            <Chips
              label={purgeLabel(support.purge)}
              options={windows}
              value={purge}
              onPick={setPurge}
            />
            {support.purge === 'all' && purge !== 0 && (
              <p className="text-xs text-on-surface-variant">{PURGE_ALL_NOTE}</p>
            )}
          </Stack>
        )}
        <Stack as="label" gap="xs">
          <span className={heading}>Reason</span>
          <input
            value={reason}
            maxLength={BAN_REASON_MAX}
            onChange={e => setReason(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void submit()
            }}
            placeholder="Optional, shown to moderators"
            className={`${fieldCls} w-full text-on-surface`}
          />
        </Stack>
        <Row gap="sm" justify="end">
          <Button size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled-danger" size="md" disabled={busy} onClick={() => void submit()}>
            Ban
          </Button>
        </Row>
      </Stack>
    </Dialog>
  )
}
