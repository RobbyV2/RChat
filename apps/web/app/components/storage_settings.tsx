'use client'
import { Lock } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import {
  EARLIER_ACTION,
  EARLIER_CONFIRM,
  EARLIER_LABEL,
  SEAL_LABEL,
  STORED_ENCRYPTED,
  sealDescription,
  sealReasonText,
  type SealPlace,
  type SealState,
} from '../lib/sealing'
import { errorText } from '../lib/store'
import { Button } from './controls'
import { Row, Stack } from './layout'
import { SettingSwitch } from './settings_fields'
import { Dialog, FieldError, sectionCls } from './ui'
import { notAName } from '../lib/names'

// The small lock beside a place whose new messages are stored encrypted.
export function StoredLock({ size = 14 }: { size?: number }) {
  return (
    <span
      title={STORED_ENCRYPTED}
      aria-label={STORED_ENCRYPTED}
      role="img"
      className="inline-flex shrink-0 text-on-surface-variant"
    >
      <Lock size={size} aria-hidden />
    </span>
  )
}

// "Encrypt stored messages" of a hosted server or a P2P room: the switch, why it can't change,
// and encrypting the earlier messages. `earlierStep` renders the confirm's last step when the
// earlier messages go too (a confirmation of who you are on a hosted server, a button in P2P);
// `alsoOn` says the switch is to be turned on with them.
export function StorageSettings({
  state,
  place,
  onSwitch,
  earlierStep,
  note,
  progress,
}: {
  state: SealState
  place: SealPlace
  onSwitch(on: boolean): Promise<void>
  earlierStep(close: () => void, alsoOn: boolean): ReactNode
  note?: string | null
  progress?: string | null
}) {
  const [asking, setAsking] = useState<'on' | 'earlier' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reason = sealReasonText(state, place)
  const turn = (on: boolean) => {
    setBusy(true)
    setError(null)
    return onSwitch(on)
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false))
  }
  return (
    <>
      <p className={sectionCls}>Encrypted storage</p>
      <Stack gap="sm">
        <SettingSwitch
          label={SEAL_LABEL}
          hint={notAName(reason ?? sealDescription(place))}
          value={state.on}
          disabled={!state.available || busy}
          onChange={on => (on ? setAsking('on') : void turn(false))}
        />
        {state.on && (
          <Row as="p" gap="sm">
            <Lock size={12} aria-hidden className="shrink-0 text-on-surface-variant" />
            <span className="text-xs text-on-surface-variant">{STORED_ENCRYPTED}</span>
          </Row>
        )}
        {note && <p className="text-xs text-on-surface-variant">{note}</p>}
        {progress && (
          <p role="status" className="text-xs text-on-surface">
            {progress}
          </p>
        )}
        {state.on && (state.available || state.forced) && state.reason !== 'permission' && (
          <Row gap="none">
            <Button onClick={() => setAsking('earlier')}>{EARLIER_ACTION}</Button>
          </Row>
        )}
        <FieldError message={error} />
      </Stack>
      {asking && (
        <EarlierDialog
          place={place}
          turnOn={asking === 'on'}
          onClose={() => setAsking(null)}
          onTurnOn={() => turn(true).then(() => setAsking(null))}
          earlierStep={earlierStep}
        />
      )}
    </>
  )
}

function EarlierDialog({
  place,
  turnOn,
  onClose,
  onTurnOn,
  earlierStep,
}: {
  place: SealPlace
  turnOn: boolean
  onClose(): void
  onTurnOn(): Promise<void>
  earlierStep(close: () => void, alsoOn: boolean): ReactNode
}) {
  const [earlier, setEarlier] = useState(!turnOn)
  const [busy, setBusy] = useState(false)
  const boxId = useId()
  return (
    <Dialog full layer="confirm" title={turnOn ? SEAL_LABEL : EARLIER_ACTION} onClose={onClose}>
      <Stack gap="md">
        <p className="text-sm text-on-surface-variant">{sealDescription(place)}</p>
        {turnOn && (
          <Row as="label" htmlFor={boxId} gap="sm">
            <input
              id={boxId}
              type="checkbox"
              checked={earlier}
              onChange={e => setEarlier(e.target.checked)}
              className="size-4 accent-primary"
            />
            <span className="text-sm">{EARLIER_LABEL}</span>
          </Row>
        )}
        {earlier ? (
          <>
            <p className="text-sm text-on-surface">{EARLIER_CONFIRM}</p>
            {earlierStep(onClose, turnOn)}
          </>
        ) : (
          <Row gap="sm" justify="end">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="filled"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void onTurnOn().finally(() => setBusy(false))
              }}
            >
              Turn on
            </Button>
          </Row>
        )}
      </Stack>
    </Dialog>
  )
}
