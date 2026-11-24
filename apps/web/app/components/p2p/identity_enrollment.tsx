'use client'

import { useEffect, useRef, useState } from 'react'
import { AccountProvider, useAccount, useLiveSessions } from '../../lib/client/react'
import { client } from '../../lib/client/client'
import type { AccountSession } from '../../lib/client/session'
import {
  creationChoices,
  identityOwner,
  reserveIdentity,
} from '../../lib/client/identity_enrollment'
import { P2pProvider } from '../../lib/client/p2p_react'
import { p2pTrustText } from '../../lib/add_instance'
import { sharing, shellInfo } from '../../lib/platform'
import { FILE_LIMITS, decodeConfig, splitFile } from '../../lib/config_transfer'
import { filesHead, type P2pSection } from '../../lib/p2p/transfer'
import type { FilesPart } from '../../lib/p2p/app'
import { P2pImport } from './p2p_transfer'
import { fieldCls, filledBtn, textBtn } from '../ui'

type Slot = Awaited<ReturnType<typeof reserveIdentity>>
export type ImportedSection = { section: P2pSection; files: FilesPart | null }

export function IdentityEnrollment({
  account,
  cancel,
  imported,
}: {
  account: AccountSession
  cancel: () => void
  imported?: ImportedSection
}) {
  const source = useAccount()
  const sessions = useLiveSessions()
  const [target, setTarget] = useState(account)
  const [trusted, trust] = useState(false)
  const [name, setName] = useState('')
  const [named, setNamed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<{ slot: Slot; data: ImportedSection } | null>(null)
  const applying = useRef(false)
  const active = useRef(true)
  const reserved = useRef<Slot | null>(null)
  const owner = useRef<ReturnType<typeof identityOwner> | null>(null)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      if (!applying.current && reserved.current) void reserved.current.cancel()
    }
  }, [])
  const finish = (slot: Slot) => {
    if (!slot.current() || !active.current) return
    reserved.current = null
    cancel()
    source.store.getState().closeDialog()
    client.show(target)
    target.identities.show(slot.app)
    slot.app.p2p.openHome()
  }
  const submit = async (file: boolean) => {
    if (busy || !owner.current?.current()) return
    setBusy(true)
    setError('')
    let slot: Slot | null = null
    try {
      let data = imported
      if (file && !data) {
        const blob = await sharing().openBlob('.rchat,text/plain,application/octet-stream')
        if (!blob) return
        const split = await splitFile(blob)
        if (!split) throw Error('Could not read the config file')
        const decoded = await decodeConfig(split.text.trim(), Date.now(), FILE_LIMITS)
        if (!decoded.ok) throw Error(decoded.error)
        if (!decoded.doc.p2p) throw Error('This file contains no P2P identity')
        const head = await filesHead(split.rest, target.identities.get()?.p2p.limits().transfer)
        data = { section: decoded.doc.p2p, files: head ? { blob: split.rest, head } : null }
      }
      if (!active.current || !owner.current?.current()) return
      slot = await reserveIdentity(target, name)
      if (!active.current || !slot.current()) {
        await slot.cancel()
        return
      }
      reserved.current = slot
      if (data) setPending({ slot, data })
      else {
        await slot.app.p2p.enable(name.trim())
        if (!slot.app.useP2p.getState().enabled) throw Error('Could not enable this identity')
        finish(slot)
      }
    } catch (e) {
      if (slot) await slot.cancel()
      reserved.current = null
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const choices = creationChoices(['none'], null, null)
  const eligible = sessions.filter(a => {
    const s = a.store.getState()
    return s.me && !s.guest && s.settings.p2p
  })
  return (
    <div className="flex flex-col items-start gap-3 p-3 text-sm">
      {!trusted ? (
        <>
          <h3 className="font-semibold">Keep your P2P identity in an app you trust</h3>
          <p>
            {p2pTrustText(
              shellInfo() || typeof window === 'undefined' ? null : window.location.host
            )}
          </p>
          <button className={filledBtn} onClick={() => trust(true)}>
            I trust this app
          </button>
        </>
      ) : !named ? (
        <>
          <label>
            Attach to account{' '}
            <select
              className={fieldCls + ' streamer'}
              value={eligible.indexOf(target)}
              onChange={e => setTarget(eligible[Number(e.target.value)]!)}
            >
              {eligible.map((a, i) => (
                <option key={i} value={i}>
                  {a.store.getState().me?.username}@{new URL(a.conn.origin).host}
                </option>
              ))}
            </select>
          </label>
          <label>
            Identity name{' '}
            <input
              className={fieldCls + ' streamer'}
              maxLength={32}
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </label>
          <button
            className={filledBtn}
            disabled={!name.trim() || !eligible.includes(target)}
            onClick={() => {
              owner.current = identityOwner(target)
              setNamed(true)
            }}
          >
            Continue
          </button>
        </>
      ) : pending ? (
        <AccountProvider session={target}>
          <P2pProvider identity={pending.slot.app}>
            <P2pImport
              {...pending.data}
              enrolling
              onApplying={value => {
                applying.current = value
                if (active.current) setBusy(value)
                else if (!value && reserved.current) void reserved.current.cancel()
              }}
              onImported={() => finish(pending.slot)}
            />
          </P2pProvider>
        </AccountProvider>
      ) : (
        <>
          {!imported && (
            <>
              <p>
                This identity will be stored on this device. To move it later, export an encrypted
                copy from Sync config.
              </p>
              <p>
                On iPhone and iPad, Safari may delete this data after 7 days without a visit.
                Install the app to keep it longer.
              </p>
              {choices.map(choice => (
                <button
                  key={choice}
                  disabled={busy}
                  className={filledBtn}
                  onClick={() => void submit(false)}
                >
                  Create without a recovery phrase
                </button>
              ))}
            </>
          )}
          <button disabled={busy} className={textBtn} onClick={() => void submit(true)}>
            Import {imported ? 'this identity' : 'a .rchat file'}
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy} className={textBtn} onClick={cancel}>
        Cancel
      </button>
    </div>
  )
}
