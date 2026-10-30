'use client'

import { useEffect, useState } from 'react'
import { useStore } from '../../lib/store'
import { p2p, useP2p } from '../../lib/p2p/app'
import { cleanName } from '../../lib/p2p/keys'
import { iceOffer } from '../../lib/ice'
import { fmtSize } from '../../lib/bytes'
import { SettingSwitch } from '../admin_panel'
import { dangerBtn, fieldCls, filledBtn, sectionCls, textBtn } from '../ui'
import { MyCode } from './add_contact'
import { P2pBadge } from './p2p_badge'
import { ElsewhereNotice } from './p2p_home'

function NameField() {
  const name = useP2p(s => s.name)
  const [value, setValue] = useState(name)
  useEffect(() => setValue(name), [name])
  const clean = cleanName(value)
  return (
    <div className="flex gap-2">
      <input
        value={value}
        maxLength={32}
        onChange={e => setValue(e.target.value)}
        aria-label="P2P display name"
        className={`${fieldCls} streamer`}
      />
      <button
        onClick={() => void p2p.setName(value)}
        disabled={!clean || clean === name}
        className={textBtn}
      >
        Save
      </button>
    </div>
  )
}

// Settings > Peer-to-peer. Off until the user turns it on; only for signed-in accounts.
export function P2pSection() {
  const signedIn = useStore(s => s.me !== null)
  const enabled = useP2p(s => s.enabled)
  const loading = useP2p(s => s.loading)
  const paused = useP2p(s => s.paused)
  const fp = useP2p(s => s.fingerprint)
  const storage = useP2p(s => s.storage)
  const error = useP2p(s => s.error)
  const elsewhere = useP2p(s => s.elsewhere)
  const helpers = useStore(s => s.iceHelpers)
  const setHelpers = useStore(s => s.setIceHelpers)
  const info = useStore(s => s.instance?.ice)
  const ask = useStore(s => s.askConfirm)
  useEffect(() => {
    if (enabled) void p2p.refreshStorage()
  }, [enabled])
  if (!signedIn) return null
  const offer = iceOffer(info)
  return (
    <section aria-label="Peer-to-peer">
      <p className={`${sectionCls} flex items-center gap-2`}>
        Peer-to-peer <P2pBadge />
      </p>
      {!enabled ? (
        <div className="flex flex-col items-start gap-2 px-2">
          <p className="text-xs text-on-surface-variant">
            Contacts you add by code, connected straight to you. Off by default.
          </p>
          <button onClick={() => p2p.openDialog({ kind: 'enable' })} className={filledBtn}>
            Turn on P2P
          </button>
        </div>
      ) : elsewhere ? (
        <ElsewhereNotice />
      ) : loading ? (
        <p className="px-2 text-sm text-on-surface-variant">Starting…</p>
      ) : (
        <div className="flex flex-col gap-4">
          {error && (
            <p role="alert" className="px-2 text-xs text-error">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-2 px-2">
            <p className="text-sm font-medium">Your contact code</p>
            <MyCode />
          </div>
          <div className="flex flex-col gap-1 px-2">
            <p className="text-sm font-medium">Name shown to contacts</p>
            <NameField />
            <p className="streamer font-mono text-[11px] text-on-surface-variant">Key {fp}</p>
          </div>
          <div>
            <SettingSwitch
              label="Pause P2P"
              value={paused}
              onChange={on => void p2p.setPaused(on)}
            />
            <p className="mt-1 px-2 text-xs text-on-surface-variant">
              Stops every P2P connection. Nothing is delivered while paused.
            </p>
          </div>
          <div>
            <SettingSwitch label="Use connection helpers" value={helpers} onChange={setHelpers} />
            <p className="mt-1 px-2 text-xs text-on-surface-variant">
              {helpers && offer.length
                ? `In use: ${offer.join(', ')}.`
                : 'None: direct connections only, same network.'}{' '}
              The instance can see when you are online and who you connect to, not what you say.
              While you are offline, anyone with your code can take your P2P address and see when
              your contacts try to reach you, and from which IP unless helpers relay everything.
            </p>
          </div>
          <div className="px-2 text-xs text-on-surface-variant">
            <p className="text-sm font-medium text-on-surface">Storage</p>
            <p data-p2p-storage>
              {storage
                ? `This site uses ${fmtSize(storage.usage)} of ${fmtSize(storage.quota)} in this browser.`
                : 'Storage use is not available in this browser.'}
            </p>
            <p className="mt-1">
              Moving to a new device isn&apos;t available yet. Removing this data loses your
              contacts.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 px-1">
            <button
              onClick={() =>
                ask({
                  title: 'Reset your P2P identity?',
                  body: 'You get a new key. Contacts move over when you next connect, but have to verify you again.',
                  confirm: 'Reset',
                  action: () => void p2p.resetIdentity(),
                })
              }
              className={textBtn}
            >
              Reset identity
            </button>
            <button
              onClick={() =>
                ask({
                  title: 'Remove P2P data from this browser?',
                  body: 'Your P2P identity and contacts are deleted from this browser. Without a backup they are gone for good.',
                  confirm: 'Remove',
                  action: () => void p2p.removeData(),
                })
              }
              className={dangerBtn}
            >
              Remove P2P data from this browser
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
