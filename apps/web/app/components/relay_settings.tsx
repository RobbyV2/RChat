'use client'

import { useId, useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../lib/store'
import {
  AUTO,
  RELAYS_MAX,
  displayHost,
  hostOf,
  isTurn,
  manualRelays,
  parseRelayUrl,
  promptText,
  type RelayChoice,
  type RelayPrefs,
} from '../lib/relays'
import { SettingSwitch } from './admin_panel'
import { Dialog, FieldError, fieldCls, filledBtn, iconBtn, sectionCls, textBtn } from './ui'

const relayLabel = (url: string) => displayHost(hostOf(url) ?? url)

// The relay picker for one P2P action: auto, or one of the user's TURN relays.
export function RelayPicker({
  value,
  onChange,
  prefs,
  label = 'Relay',
}: {
  value: RelayChoice
  onChange: (choice: RelayChoice) => void
  prefs: RelayPrefs
  label?: string
}) {
  const id = useId()
  const manual = manualRelays(prefs)
  if (manual.length === 0) return null
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="shrink-0 text-sm text-on-surface-variant">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`${fieldCls} bg-surface-container-high`}
      >
        <option value={AUTO}>Auto (best working relay)</option>
        {manual.map(r => (
          <option key={r.url} value={r.url}>
            Only {relayLabel(r.url)}
          </option>
        ))}
      </select>
    </div>
  )
}

function AddRelay({ prefs }: { prefs: RelayPrefs }) {
  const saveRelays = useStore(s => s.saveRelays)
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [credential, setCredential] = useState('')
  const [error, setError] = useState<string | null>(null)
  const errorId = useId()
  const full = prefs.relays.length >= RELAYS_MAX
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const parsed = parseRelayUrl(url)
    if (!parsed.ok) return setError(parsed.error)
    if (prefs.relays.some(r => r.url === parsed.url)) return setError('That relay is already added')
    if (parsed.scheme === 'stun' && (username || credential))
      return setError('STUN servers take no username or password')
    saveRelays({
      ...prefs,
      relays: [
        ...prefs.relays,
        {
          url: parsed.url,
          ...(username ? { username } : {}),
          ...(credential ? { credential } : {}),
        },
      ],
    })
    setUrl('')
    setUsername('')
    setCredential('')
    setError(null)
  }
  return (
    <form onSubmit={submit} className="mt-2 flex flex-col gap-2 px-2">
      <input
        value={url}
        onChange={e => {
          setUrl(e.target.value)
          setError(null)
        }}
        placeholder="Address (stun:, turn: or turns:)"
        aria-label="Relay address"
        aria-describedby={error ? errorId : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={full}
        className={fieldCls}
      />
      <div className="flex flex-wrap gap-2">
        <input
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder="Username (optional)"
          aria-label="Relay username"
          autoComplete="off"
          disabled={full}
          className={fieldCls}
        />
        <input
          type="password"
          value={credential}
          onChange={e => setCredential(e.target.value)}
          placeholder="Password (optional)"
          aria-label="Relay password"
          autoComplete="new-password"
          disabled={full}
          className={fieldCls}
        />
      </div>
      <FieldError id={errorId} message={error} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-on-surface-variant">
          {full ? `Up to ${RELAYS_MAX} relays.` : 'Logins stay on this device.'}
        </span>
        <button type="submit" disabled={full || !url.trim()} className={filledBtn}>
          Add relay
        </button>
      </div>
    </form>
  )
}

export function RelaySection() {
  const signedIn = useStore(s => s.me !== null)
  const prefs = useStore(s => s.relayPrefs)
  const saveRelays = useStore(s => s.saveRelays)
  if (!signedIn) return null
  const remove = (url: string) =>
    saveRelays({ ...prefs, relays: prefs.relays.filter(r => r.url !== url) })
  const forget = (host: string) =>
    saveRelays({ ...prefs, allowed: prefs.allowed.filter(h => h !== host) })
  return (
    <section>
      <p className={sectionCls}>Your relays</p>
      <p className="mb-2 px-2 text-xs text-on-surface-variant">
        Add your own STUN or TURN servers. P2P files and P2P calls use them along with the ones
        offered here. Each side uses its own relays, so people with different relays still connect,
        relay to relay.
      </p>
      {prefs.relays.length > 0 && (
        <ul className="flex flex-col gap-1 px-2">
          {prefs.relays.map(r => (
            <li
              key={r.url}
              className="flex items-center gap-2 rounded-xl bg-surface-container px-3 py-1.5"
            >
              <span className="shrink-0 rounded bg-surface-container-highest px-1 py-0.5 text-[10px] leading-none font-bold text-on-surface-variant">
                {isTurn(r.url) ? 'TURN' : 'STUN'}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={r.url}>
                {r.url}
              </span>
              {r.username !== undefined && (
                <span className="shrink-0 text-xs text-on-surface-variant">Login saved</span>
              )}
              <button
                type="button"
                title="Remove relay"
                aria-label={`Remove relay ${relayLabel(r.url)}`}
                onClick={() => remove(r.url)}
                className={`${iconBtn} p-1`}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <AddRelay prefs={prefs} />
      <div className="mt-3 px-2">
        <RelayPicker
          label="Default for P2P"
          value={prefs.choice}
          prefs={prefs}
          onChange={choice => saveRelays({ ...prefs, choice })}
        />
      </div>
      {manualRelays(prefs).length > 0 && (
        <p className="mt-1 px-2 text-xs text-on-surface-variant">
          Auto uses every relay and skips the ones that fail. A single relay never falls back, so
          you get an error if it fails.
        </p>
      )}
      <div className="mt-3">
        <SettingSwitch
          label="Ask before using unknown relays"
          value={prefs.ask}
          onChange={ask => saveRelays({ ...prefs, ask })}
        />
      </div>
      <p className="mt-2 px-2 text-xs text-on-surface-variant">
        Someone you connect to may use a relay you don&apos;t know, which can see your IP address.
        Relay only is the only real protection, since a peer can always skip relays.
      </p>
      <p className="mt-3 px-2 text-xs font-medium text-on-surface-variant">Always allowed</p>
      {prefs.allowed.length ? (
        <ul className="mt-1 flex flex-col gap-1 px-2">
          {prefs.allowed.map(host => (
            <li
              key={host}
              className="flex items-center gap-2 rounded-xl bg-surface-container px-3 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{displayHost(host)}</span>
              <button
                type="button"
                title="Remove from allowed"
                aria-label={`Remove ${displayHost(host)} from allowed`}
                onClick={() => forget(host)}
                className={`${iconBtn} p-1`}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 px-2 text-xs text-on-surface-variant">None yet.</p>
      )}
    </section>
  )
}

// Asks before connecting through another side's relay this device doesn't know.
export function RelayPrompt() {
  const host = useStore(s => s.relayPrompt)
  const answer = useStore(s => s.answerRelayPrompt)
  if (host === null) return null
  return (
    <Dialog title="Unknown relay" onClose={() => answer('deny')} layer="confirm" compact>
      <p className="text-sm break-words text-on-surface-variant">{promptText(host)}</p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={() => answer('deny')} className={textBtn}>
          Deny
        </button>
        <button type="button" onClick={() => answer('once')} className={textBtn}>
          Allow once
        </button>
        <button type="button" onClick={() => answer('always')} className={filledBtn}>
          Always allow
        </button>
      </div>
    </Dialog>
  )
}
