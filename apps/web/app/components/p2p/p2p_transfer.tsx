'use client'
import { Button } from '../controls'
import { Row, Stack, Surface } from '../layout'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'

import { useEffect, useId, useRef, useState } from 'react'
import { client } from '../../lib/client/client'
import { useStore } from '../../lib/store'
import { type FilesPart, type Unlocked } from '../../lib/p2p/app'
import {
  Cancelled,
  fastKdf,
  passProblem,
  passStrength,
  percent,
  SLOW_KDF,
  summaryText,
  whileSlow,
  type P2pSection,
} from '../../lib/p2p/transfer'
import { fmtSize } from '../../lib/bytes'
import { FieldError, fieldCls } from '../ui'

// The P2P part of Sync config: an encrypted copy of the identity and history for moving to a
// new device, and its import.

export interface PassState {
  pass: string
  again: string
  // Downloaded (and sent) files go along too.
  files?: boolean
}

// Off by default, with the size shown. Any size: the files are streamed into the file.
function FilesOption({ value, onChange }: { value: boolean; onChange: (on: boolean) => void }) {
  const identity = useP2pApp()!
  const { p2pTransfer } = identity

  const [size, setSize] = useState<number | null>(null)
  const id = useId()
  useEffect(() => {
    let live = true
    void p2pTransfer.filesSize().then(n => live && setSize(n))
    return () => {
      live = false
    }
  }, [])
  return (
    <Row gap="sm" align="baseline">
      <input
        id={id}
        type="checkbox"
        checked={value}
        disabled={size === 0}
        onChange={e => onChange(e.target.checked)}
        className="accent-primary"
        data-p2p-include-files
      />
      <Stack gap="3xs">
        <Row as="label" htmlFor={id} gap="sm">
          <span className="text-sm">Include downloaded attachments</span>
          {size !== null && (
            <span className="text-xs text-on-surface-variant tabular-nums">({fmtSize(size)})</span>
          )}
        </Row>
        <p className="text-xs text-on-surface-variant">
          Files you sent go too, in the downloaded file only (not the text or QR code). Without
          this, the new device downloads them again from contacts who have them.
        </p>
      </Stack>
    </Row>
  )
}

// Loads the WebAssembly key module once the user gets to the passphrase (`wanted`).
const usePreloadKdf = (wanted: boolean) =>
  useEffect(() => {
    if (wanted) void fastKdf()
  }, [wanted])

// Next to the progress of a key made in JavaScript, once it has run for `SLOW_AFTER` ms.
export const SlowNote = () => (
  <p role="status" data-slow-kdf className="text-xs text-on-surface">
    {SLOW_KDF}
  </p>
)

const strengthCls = ['text-error', 'text-error', 'text-tertiary', 'text-primary']

function P2pExportOptionBody({
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
  const identity = useP2pApp()!
  const { p2p } = identity

  const strength = passStrength(value.pass, p2p.limits().transfer)
  const problem = value.again ? passProblem(value.pass, value.again, p2p.limits().transfer) : null
  const id = useId()
  usePreloadKdf(on)
  return (
    <Row gap="sm" align="baseline">
      <input
        id={id}
        type="checkbox"
        checked={on}
        onChange={e => onToggle(e.target.checked)}
        className="cursor-pointer accent-primary"
      />
      <Stack gap="sm" place="flex-1">
        <label htmlFor={id} className="cursor-pointer text-sm">
          Include P2P identity and history
        </label>
        {on && (
          <>
            <p className="text-xs text-on-surface-variant">
              Encrypted with a passphrase. Anyone with the file and the passphrase can use your P2P
              identity. Sending pauses here after the export, and stops for good once the new device
              has it. Never in share links. This is for moving, not for a lost or stolen device:
              reset your identity for that.
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
              <p
                data-strength={strength.score}
                className={`text-xs ${strengthCls[strength.score]}`}
              >
                {strength.label}
              </p>
            )}
            <FieldError message={problem} />
            <FilesOption value={!!value.files} onChange={files => onChange({ ...value, files })} />
          </>
        )}
      </Stack>
    </Row>
  )
}

const caseText = {
  new: 'This browser takes over the identity. Contacts see that you moved to a new device, and the old browser stops sending.',
  merge: 'This browser already has this identity. Contacts and history are merged.',
  replace:
    'This browser has a different P2P identity. Replacing it deletes that identity, its contacts and its history from this browser for good. Export it first if you still need it.',
}

function P2pImportBody({
  section,
  files = null,
  enrolling = false,
  onImported,
  onApplying,
}: {
  section: P2pSection
  files?: FilesPart | null
  enrolling?: boolean
  onImported?: () => void
  onApplying?: (busy: boolean) => void
}) {
  const identity = useP2pApp()!
  const { p2pTransfer, p2p } = identity
  const signedIn = useStore(s => s.me !== null)
  const ask = useStore(s => s.askConfirm)
  const closeDialog = useStore(s => s.closeDialog)
  const elsewhere = useP2p(s => s.elsewhere)
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState<'unlock' | 'apply' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [read, setRead] = useState(0)
  const [part, setPart] = useState<number | null>(null)
  const stop = useRef<AbortController | null>(null)
  const [late, setLate] = useState(false)
  usePreloadKdf(signedIn)
  useEffect(() => () => stop.current?.abort(), [])

  const unlock = async () => {
    const ctl = new AbortController()
    stop.current = ctl
    setBusy('unlock')
    setError(null)
    setPart(null)
    try {
      const watch = { progress: setPart, signal: ctl.signal }
      const result = await whileSlow(p2pTransfer.unlock(section, pass, files, watch), setLate)
      if (
        enrolling &&
        (result.kind !== 'new' ||
          client.book
            .getState()
            .instances.some(i =>
              i.accounts.some(a => a.identities.some(peer => peer.ik === result.summary.ik))
            ) ||
          client
            .live()
            .some(a =>
              a.identities
                .list()
                .some(peer => peer !== identity && peer.useP2p.getState().ik === result.summary.ik)
            ))
      )
        throw Error('This identity already belongs to a saved account on this device')
      setUnlocked(result)
      setPass('')
    } catch (e) {
      if (!(e instanceof Cancelled)) setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      setPart(null)
    }
  }

  const apply = async (u: Unlocked) => {
    onApplying?.(true)
    setBusy('apply')
    setError(null)
    setRead(0)
    let out: Awaited<ReturnType<typeof p2pTransfer.apply>>
    try {
      out = await p2pTransfer.apply(u, setRead)
      if (!out.ok) throw Error(out.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    } finally {
      onApplying?.(false)
      setBusy(null)
    }
    setUnlocked(null)
    onImported?.()
    const f = out.res.files
    const filesText = !f
      ? ''
      : ` ${f.files.toLocaleString('en-US')} ${f.files === 1 ? 'file' : 'files'} added${
          f.skipped ? `, ${f.skipped.toLocaleString('en-US')} skipped (damaged)` : ''
        }.${f.complete ? '' : ' The file was cut short: download the rest again from contacts.'}`
    setDone(
      (out.res.kind === 'merge'
        ? `Merged. ${out.res.events.toLocaleString('en-US')} new events.`
        : 'Imported. Contacts reach you here the next time they connect.') + filesText
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
    <Surface as="section" aria-label="P2P identity" pad="lg" gap="md">
      <p className="text-sm font-medium text-on-surface">P2P identity and history</p>
      {!signedIn ? (
        <p className="text-sm text-on-surface-variant">Sign in to import a P2P identity.</p>
      ) : done ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="text-sm text-on-surface">
            {done}
          </p>
          <Button
            onClick={() => {
              closeDialog()
              p2p.openHome()
            }}
          >
            Open P2P
          </Button>
        </div>
      ) : !unlocked ? (
        <form
          onSubmit={e => {
            e.preventDefault()
            if (pass && !busy) void unlock()
          }}
          className="flex flex-wrap gap-2"
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
          <Button type="submit" variant="filled" size="md" disabled={!pass || busy !== null}>
            {busy !== 'unlock'
              ? 'Unlock'
              : part === null
                ? 'Unlocking…'
                : `Unlocking ${percent(part)}`}
          </Button>
          {busy === 'unlock' && part !== null && part < 1 && (
            <Button onClick={() => stop.current?.abort()}>Cancel</Button>
          )}
          {busy === 'unlock' && part !== null && late && (
            <Stack gap="none" place="w-full">
              <SlowNote />
            </Stack>
          )}
        </form>
      ) : (
        <Stack gap="sm">
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
            <div role="status" className="flex flex-wrap items-center gap-3">
              <p className="text-sm">P2P is open in another tab. Use it here to import.</p>
              <Button onClick={() => p2p.useHere()}>Use here</Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                variant={unlocked.kind === 'replace' ? 'danger' : 'filled'}
                size="md"
                disabled={busy !== null}
                onClick={() => confirmApply(unlocked)}
              >
                {busy === 'apply'
                  ? read > 0
                    ? `Importing files (${fmtSize(read)})…`
                    : 'Importing…'
                  : unlocked.kind === 'merge'
                    ? 'Merge'
                    : unlocked.kind === 'replace'
                      ? 'Replace'
                      : 'Import'}
              </Button>
              <Button disabled={busy !== null} onClick={() => setUnlocked(null)}>
                Cancel
              </Button>
            </div>
          )}
        </Stack>
      )}
      <FieldError message={error} />
    </Surface>
  )
}

export const P2pExportOption = withP2pIdentity(P2pExportOptionBody)
export const P2pImport = withP2pIdentity(P2pImportBody)
