'use client'

import { useState } from 'react'
import { useStore } from '../../lib/store'
import { p2p, p2pTransfer, useP2p, type Unlocked } from '../../lib/p2p/app'
import { passProblem, passStrength, summaryText, type P2pSection } from '../../lib/p2p/transfer'
import { dangerBtn, FieldError, fieldCls, filledBtn, textBtn } from '../ui'

// The P2P part of Sync config: an encrypted copy of the identity and history for moving to a
// new device, and its import.

export interface PassState {
  pass: string
  again: string
}

const strengthCls = ['text-error', 'text-error', 'text-tertiary', 'text-primary']

export function P2pExportOption({
  on,
  onToggle,
  value,
  onChange,
}: {
  on: boolean
  onToggle: (on: boolean) => void
  value: PassState
  onChange: (v: PassState) => void
}) {
  const strength = passStrength(value.pass)
  const problem = value.again ? passProblem(value.pass, value.again) : null
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={on}
          onChange={e => onToggle(e.target.checked)}
          className="accent-primary"
        />
        Include P2P identity and history
      </label>
      {on && (
        <div className="flex flex-col gap-2 pl-6">
          <p className="text-xs text-on-surface-variant">
            Encrypted with a passphrase. Anyone with the file and the passphrase can use your P2P
            identity. Sending pauses here after the export, and stops for good once the new device
            has it. Never in share links. This is for moving, not for a lost or stolen device: reset
            your identity for that.
          </p>
          <input
            type="password"
            autoComplete="new-password"
            value={value.pass}
            onChange={e => onChange({ ...value, pass: e.target.value })}
            placeholder="Passphrase (at least 10 characters)"
            aria-label="Passphrase"
            className={fieldCls}
          />
          <input
            type="password"
            autoComplete="new-password"
            value={value.again}
            onChange={e => onChange({ ...value, again: e.target.value })}
            placeholder="Passphrase again"
            aria-label="Passphrase again"
            className={fieldCls}
          />
          {value.pass && (
            <p data-strength={strength.score} className={`text-xs ${strengthCls[strength.score]}`}>
              {strength.label}
            </p>
          )}
          <FieldError message={problem} />
        </div>
      )}
    </div>
  )
}

const caseText = {
  new: 'This browser takes over the identity. Contacts see that you moved to a new device, and the old browser stops sending.',
  merge: 'This browser already has this identity. Contacts and history are merged.',
  replace:
    'This browser has a different P2P identity. Replacing it deletes that identity, its contacts and its history from this browser for good. Export it first if you still need it.',
}

export function P2pImport({ section }: { section: P2pSection }) {
  const signedIn = useStore(s => s.me !== null)
  const ask = useStore(s => s.askConfirm)
  const closeDialog = useStore(s => s.closeDialog)
  const elsewhere = useP2p(s => s.elsewhere)
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState<'unlock' | 'apply' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const unlock = async () => {
    setBusy('unlock')
    setError(null)
    try {
      setUnlocked(await p2pTransfer.unlock(section, pass))
      setPass('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const apply = async (u: Unlocked) => {
    setBusy('apply')
    setError(null)
    const out = await p2pTransfer.apply(u)
    setBusy(null)
    if (!out.ok) return setError(out.error)
    setUnlocked(null)
    setDone(
      out.res.kind === 'merge'
        ? `Merged. ${out.res.events.toLocaleString('en-US')} new events.`
        : 'Imported. Contacts reach you here the next time they connect.'
    )
  }

  const confirmApply = (u: Unlocked) =>
    u.kind === 'replace'
      ? ask({
          title: "Replace this browser's P2P identity?",
          body: 'Its contacts and history are deleted from this browser and cannot be recovered.',
          confirm: 'Replace',
          action: () => void apply(u),
        })
      : void apply(u)

  return (
    <section
      aria-label="P2P identity"
      className="flex flex-col gap-3 rounded-2xl bg-surface-container-high p-4"
    >
      <p className="text-sm font-medium text-on-surface">P2P identity and history</p>
      {!signedIn ? (
        <p className="text-sm text-on-surface-variant">Sign in to import a P2P identity.</p>
      ) : done ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="text-sm text-on-surface">
            {done}
          </p>
          <button
            type="button"
            onClick={() => {
              closeDialog()
              p2p.openHome()
            }}
            className={textBtn}
          >
            Open P2P
          </button>
        </div>
      ) : !unlocked ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={e => {
            e.preventDefault()
            if (pass && !busy) void unlock()
          }}
        >
          <input
            type="password"
            autoComplete="current-password"
            value={pass}
            onChange={e => setPass(e.target.value)}
            placeholder="Passphrase"
            aria-label="Passphrase for the P2P data"
            className={`${fieldCls} min-w-48 flex-1`}
          />
          <button type="submit" disabled={!pass || busy !== null} className={filledBtn}>
            {busy === 'unlock' ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          <p data-p2p-preview className="streamer text-sm break-words text-on-surface">
            {summaryText(unlocked.summary)}
          </p>
          <p
            className={`text-xs ${unlocked.kind === 'replace' ? 'text-error' : 'text-on-surface-variant'}`}
          >
            {unlocked.already
              ? 'This file was already imported here. Nothing changes.'
              : caseText[unlocked.kind]}
          </p>
          {elsewhere ? (
            <div role="status" className="flex flex-wrap items-center gap-3 text-sm">
              <p>P2P is open in another tab. Use it here to import.</p>
              <button type="button" onClick={() => p2p.useHere()} className={textBtn}>
                Use here
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => confirmApply(unlocked)}
                className={unlocked.kind === 'replace' ? dangerBtn : filledBtn}
              >
                {busy === 'apply'
                  ? 'Importing…'
                  : unlocked.kind === 'merge'
                    ? 'Merge'
                    : unlocked.kind === 'replace'
                      ? 'Replace'
                      : 'Import'}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => setUnlocked(null)}
                className={textBtn}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
      <FieldError message={error} />
    </section>
  )
}
