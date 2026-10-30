'use client'

import { useEffect, useState } from 'react'
import { Eye } from 'lucide-react'
import { useStore } from '../../lib/store'
import { p2p, useP2p } from '../../lib/p2p/app'
import { looksLikeCard, type Card } from '../../lib/p2p/card'
import { INTRO_MAX } from '../../lib/p2p/contacts'
import { fingerprint } from '../../lib/p2p/keys'
import { CopyButton, QrCode } from '../config_sync'
import { Dialog, FieldError, fieldCls, filledBtn, textBtn } from '../ui'
import { KeyAvatar } from './p2p_badge'
import { QrScan } from './qr_scan'

const areaCls = `${fieldCls} w-full resize-none font-mono text-xs break-all md:text-xs`

// Our contact code as a QR and a string. In streamer mode both stay hidden until asked for.
export function MyCode() {
  const card = useP2p(s => s.card)
  const streamer = useStore(s => s.streamer)
  const [shown, setShown] = useState(false)
  if (!card) return <p className="text-sm text-on-surface-variant">Preparing your code…</p>
  if (streamer && !shown)
    return (
      <button
        type="button"
        onClick={() => setShown(true)}
        className={`${textBtn} flex items-center gap-1.5`}
      >
        <Eye size={16} />
        Show code
      </button>
    )
  return (
    <div className="flex flex-col items-start gap-3">
      <div className="w-72 max-w-full">
        <QrCode text={card} label="Your P2P contact code" wide />
      </div>
      <div className="flex w-full items-start gap-1">
        <textarea
          readOnly
          value={card}
          rows={4}
          aria-label="Your P2P contact code"
          data-p2p-card
          onFocus={e => e.currentTarget.select()}
          className={areaCls}
        />
        <CopyButton text={card} label="Copy contact code" />
      </div>
      <p className="text-xs text-on-surface-variant">
        Anyone with this code can send you a contact request. Share it only with people you want to
        hear from.
      </p>
    </div>
  )
}

type Tab = 'scan' | 'paste' | 'mine'

function Preview({ card }: { card: Card }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-surface-container px-3 py-2">
      <KeyAvatar ik={card.ik} />
      <div className="min-w-0">
        <p className="streamer truncate text-sm font-medium">{card.name || 'Unnamed'}</p>
        <p className="streamer truncate font-mono text-[11px] text-on-surface-variant">
          {fingerprint(card.ik)}
        </p>
      </div>
    </div>
  )
}

export function AddContactDialog({ initial = 'paste' }: { initial?: Tab }) {
  const [tab, setTab] = useState<Tab>(initial)
  const [code, setCode] = useState('')
  const [intro, setIntro] = useState('')
  const [card, setCard] = useState<Card | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = p2p.closeDialog

  useEffect(() => {
    let live = true
    const text = code.trim()
    if (!text) {
      setCard(null)
      setError(null)
      return
    }
    if (!looksLikeCard(text)) {
      setCard(null)
      setError("That isn't a valid P2P contact code")
      return
    }
    void (async () => {
      try {
        const c = await p2p.readCard(text)
        if (!live) return
        setCard(c)
        setError(c ? null : "That isn't a valid P2P contact code")
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      live = false
    }
  }, [code])

  const add = async () => {
    setBusy(true)
    const res = await p2p.addContact(code, intro)
    setBusy(false)
    if (!res) return setError(useP2p.getState().error ?? "Couldn't add that contact")
    if (!res.ok) return setError(res.error)
    useStore
      .getState()
      .showToast(res.contact.state === 'mutual' ? 'Contact added' : 'Contact request sent')
    p2p.openDialog({ kind: 'contact', ik: res.contact.ik })
  }

  const tabs: [Tab, string][] = [
    ['scan', 'Scan'],
    ['paste', 'Paste'],
    ['mine', 'My code'],
  ]

  return (
    <Dialog title="Add a P2P contact" onClose={close} full>
      <div role="tablist" className="mb-4 flex gap-1">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`rounded-full px-3 py-1.5 text-sm ${
              tab === key
                ? 'bg-secondary-container text-on-secondary-container'
                : 'text-on-surface-variant hover:bg-surface-container-highest'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'mine' ? (
        <MyCode />
      ) : (
        <div className="flex flex-col gap-3">
          {tab === 'scan' && !card && (
            <QrScan
              label="Camera view for a contact code"
              onCode={text => {
                setCode(text)
                setTab('paste')
              }}
            />
          )}
          {(tab === 'paste' || card) && (
            <textarea
              autoFocus={tab === 'paste'}
              value={code}
              onChange={e => setCode(e.target.value)}
              rows={4}
              placeholder="Paste a contact code (rcp1.…)"
              aria-label="Contact code"
              className={`${areaCls} streamer`}
            />
          )}
          <FieldError message={error} />
          {card && (
            <>
              <Preview card={card} />
              <textarea
                value={intro}
                maxLength={INTRO_MAX}
                onChange={e => setIntro(e.target.value)}
                rows={2}
                placeholder="Say who you are (optional)"
                aria-label="Introduction"
                className={`${fieldCls} w-full resize-none`}
              />
              <p className="text-xs text-on-surface-variant">
                They see your request the next time you are both online.
              </p>
            </>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button onClick={close} className={textBtn}>
              Cancel
            </button>
            <button onClick={() => void add()} disabled={!card || busy} className={filledBtn}>
              Send request
            </button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
