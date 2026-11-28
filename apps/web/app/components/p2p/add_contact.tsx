'use client'
import { Name } from '../name'
import { p2pKey, p2pName } from '../../lib/names'
import { identityPerson } from '../../lib/people'
import { Button, Tab } from '../controls'
import { Row, Stack, Surface } from '../layout'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'

import { useEffect, useState } from 'react'
import { Eye } from 'lucide-react'
import { useStore } from '../../lib/store'

import { looksLikeCard, type Card } from '../../lib/p2p/card'
import { fingerprint } from '../../lib/p2p/keys'
import { CopyButton, QrCode } from '../config_sync'
import { Dialog, FieldError, fieldCls } from '../ui'
import { KeyAvatar } from './p2p_badge'
import { QrScan } from './qr_scan'

const areaCls = `${fieldCls} w-full resize-none font-mono text-xs break-all md:text-xs`

// Our contact code as a QR and a string. In streamer mode both stay hidden until asked for.
function MyCodeBody() {
  const card = useP2p(s => s.card)
  const streamer = useStore(s => s.streamer)
  const [shown, setShown] = useState(false)
  if (!card) return <p className="text-sm text-on-surface-variant">Preparing your code…</p>
  if (streamer && !shown)
    return (
      <Button onClick={() => setShown(true)}>
        <Eye size={16} />
        Show code
      </Button>
    )
  return (
    <Stack gap="md" align="start">
      <QrCode text={card} label="Your P2P contact code" wide />
      <Row gap="2xs" align="start" place="w-full">
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
      </Row>
      <p className="text-xs text-on-surface-variant">
        Anyone with this code can send you a contact request. Share it only with people you want to
        hear from.
      </p>
    </Stack>
  )
}

type ContactTab = 'scan' | 'paste' | 'mine'

function Preview({ card }: { card: Card }) {
  return (
    <Surface pad="md" tone="base" radius="lg">
      <Row gap="md">
        <KeyAvatar person={identityPerson(card.ik, 'contact')} />
        <div className="min-w-0">
          <Name as="p" of={p2pName(card.name || 'Unnamed')} look="truncate text-sm font-medium" />
          <Name
            as="p"
            of={p2pKey(fingerprint(card.ik))}
            look="truncate font-mono text-2xs text-on-surface-variant"
          />
        </div>
      </Row>
    </Surface>
  )
}

function AddContactDialogBody({
  initial = 'paste',
  code: given = '',
  routed,
}: {
  initial?: ContactTab
  code?: string
  routed?: { close(): void; valid(): boolean; finish(): void }
}) {
  const identity = useP2pApp()!
  const { p2p } = identity

  const [tab, setTab] = useState<ContactTab>(initial)
  const [code, setCode] = useState(given)
  const [intro, setIntro] = useState('')
  const [card, setCard] = useState<Card | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = routed?.close ?? p2p.closeDialog

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
    if (routed && !routed.valid()) return close()
    setBusy(true)
    const res = await p2p.addContact(code, intro)
    setBusy(false)
    if (routed && !routed.valid()) return
    if (!res) return setError(identity.useP2p.getState().error ?? "Couldn't add that contact")
    if (!res.ok) return setError(res.error)
    routed?.finish()
    identity.p2pHost.toast(
      res.contact.state === 'mutual' ? 'Contact added' : 'Contact request sent'
    )
    p2p.openDialog({ kind: 'contact', ik: res.contact.ik })
  }

  const tabs: [ContactTab, string][] = [
    ['scan', 'Scan'],
    ['paste', 'Paste'],
    ['mine', 'My code'],
  ]

  return (
    <Dialog title="Add a P2P contact" onClose={close} full>
      <Stack gap="lg">
        <Row role="tablist" gap="2xs" align="stretch">
          {tabs.map(([key, label]) => (
            <Tab key={key} selected={tab === key} onClick={() => setTab(key)}>
              {label}
            </Tab>
          ))}
        </Row>
        {tab === 'mine' ? (
          <MyCode />
        ) : (
          <>
            <Stack gap="md">
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
                    maxLength={p2p.limits().contacts.introMax}
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
            </Stack>
            <Row gap="sm" justify="end">
              <Button size="md" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="filled"
                size="md"
                onClick={() => void add()}
                disabled={!card || busy}
              >
                Send request
              </Button>
            </Row>
          </>
        )}
      </Stack>
    </Dialog>
  )
}

export const MyCode = withP2pIdentity(MyCodeBody)
export const AddContactDialog = withP2pIdentity(AddContactDialogBody)
