'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useStore } from '../../lib/store'
import { autoChoices, p2p, p2pBadge, p2pFiles, useP2p } from '../../lib/p2p/app'
import { cleanName } from '../../lib/p2p/keys'
import {
  applyUser,
  instanceLocal,
  LIMITS_LATER,
  limitChoices,
  limitText,
  readUserLimits,
  valueOf,
  writeUserLimits,
  type UserField,
} from '../../lib/p2p/user_limits'
import { iceOffer } from '../../lib/ice'
import { fmtSize } from '../../lib/bytes'
import { SettingSwitch } from '../admin_panel'
import { dangerBtn, fieldCls, filledBtn, sectionCls, textBtn } from '../ui'
import { DevicesSection } from './p2p_server_flows'
import { MyCode } from './add_contact'
import { badgeDate, P2pBadge } from './p2p_badge'
import { confirmReset, ElsewhereNotice, IdentityAlert, MovedBanner, MovingBanner } from './p2p_home'

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

export const BADGE_ON_BODY =
  'Contacts, people you sent a request to and server members see "Confirmed as" and your account name next to your P2P name. The instance learns your P2P identity key, which links your P2P activity to your account. While this is on, it renews the confirmation every day.'

export const badgeOffBody = (until: number | null) =>
  `Peers who already have your confirmation keep showing it until it expires${
    until ? `, on ${badgeDate(until)}` : ''
  }, at most 7 days from now. They may then show it as expired for up to 30 days. P2P servers you joined keep the old confirmation in their history.`

// Settings > Peer-to-peer > Account badge (opt-in, note section 2).
function BadgeSetting() {
  const badge = useP2p(s => s.badge)
  const busy = useP2p(s => s.badgeBusy)
  const error = useP2p(s => s.badgeError)
  const ik = useP2p(s => s.ik)
  const ask = useStore(s => s.askConfirm)
  const on = !!badge?.on
  const live = on && !!badge?.token && badge.ik === ik
  const tail = !on && badge && badge.exp * 1000 > Date.now() ? badge.exp * 1000 : null
  const change = (next: boolean) =>
    next
      ? ask({
          title: 'Show your account badge?',
          body: BADGE_ON_BODY,
          confirm: 'Turn on',
          action: () => void p2pBadge.enable(),
        })
      : ask({
          title: 'Turn off your account badge?',
          body: badgeOffBody(badge?.token ? badge.exp * 1000 : null),
          confirm: 'Turn off',
          action: () => void p2pBadge.disable(),
        })
  return (
    <div data-p2p-badge-setting>
      <SettingSwitch label="Account badge" value={on} onChange={change} disabled={busy} />
      <p className="mt-1 px-2 text-xs text-on-surface-variant">
        {busy ? (
          'Asking the instance…'
        ) : live && badge ? (
          <>
            Shown as <span className="streamer">{badge.sub}</span>. Renewed every day.
          </>
        ) : on ? (
          'On. Waiting for the instance to confirm it.'
        ) : tail ? (
          `Off. Peers who have it may show it until ${badgeDate(tail)}.`
        ) : (
          'Lets contacts see which account on this instance holds your P2P identity. Off by default.'
        )}
      </p>
      {error && (
        <p role="alert" className="mt-1 px-2 text-xs text-error">
          {error}
        </p>
      )}
    </div>
  )
}

// Never narrower than its choice: on a narrow screen it goes under its label instead.
const selectCls = fieldCls.replace('min-w-0', 'min-w-fit')

const autoLabel = (n: number) => (n === 0 ? 'Never' : `Up to ${fmtSize(n)}`)

function AutoSelect({
  label,
  value,
  options,
  onChange,
  text = autoLabel,
}: {
  label: string
  value: number
  options: number[]
  onChange: (n: number) => void
  text?: (n: number) => string
}) {
  const id = useId()
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className={`${selectCls} w-auto bg-surface-container-high`}
      >
        {options.map(n => (
          <option key={n} value={n}>
            {text(n)}
          </option>
        ))}
      </select>
    </div>
  )
}

const CLEAR_DAYS = [7, 30, 90]

// Settings > Peer-to-peer > Storage: how much one contact's files may download by themselves a
// day.
function DailySelect() {
  const info = useStore(s => s.instance)
  const [daily, setDaily] = useState(() => p2pFiles.readAuto().daily)
  return (
    <div className="mt-2" data-p2p-daily>
      <AutoSelect
        label="Automatic downloads per contact per day"
        value={daily}
        options={autoChoices(instanceLocal(info)).daily}
        text={n => `Up to ${fmtSize(n)}`}
        onChange={n => {
          setDaily(n)
          p2pFiles.writeAuto({ daily: n })
        }}
      />
      <p className="mt-1">
        Past it, or when this device has less than 10% of its storage (at least 512 MB) free, files
        wait for you to click them.
      </p>
    </div>
  )
}

// Settings > Peer-to-peer > Attachments: what downloads by itself, what is stored here, and
// clearing old downloads.
function FilesSettings() {
  const usage = useP2p(s => s.fileUsage)
  const textOnly = useStore(s => !s.settings.asset_uploads && !s.settings.p2p_attachments)
  const ask = useStore(s => s.askConfirm)
  const toast = useStore(s => s.showToast)
  const info = useStore(s => s.instance)
  const [auto, setAuto] = useState(p2pFiles.readAuto)
  const choices = autoChoices(instanceLocal(info))
  useEffect(() => {
    void p2pFiles.usage()
  }, [])
  if (textOnly)
    return (
      <p className="px-2 text-xs text-on-surface-variant">
        Attachments are turned off on this instance, so P2P files are hidden too.
      </p>
    )
  const save = (patch: Partial<typeof auto>) => {
    setAuto(a => ({ ...a, ...patch }))
    p2pFiles.writeAuto(patch)
  }
  const clear = (days: number) =>
    ask({
      title: `Clear downloads older than ${days} days?`,
      body: 'Files you downloaded before then are deleted from this browser. Files you sent stay. You can download them again while someone who has them is online.',
      confirm: 'Clear',
      action: () =>
        void p2pFiles
          .clearOlder(days)
          .then(n => toast(n === 1 ? 'Cleared 1 file' : `Cleared ${n} files`)),
    })
  return (
    <div className="flex flex-col gap-2 px-2" data-p2p-files>
      <p className="text-sm font-medium">Attachments</p>
      <AutoSelect
        label="Download automatically in direct messages"
        value={auto.dm}
        options={choices.dm}
        onChange={dm => save({ dm })}
      />
      <AutoSelect
        label="Download images automatically in P2P servers"
        value={auto.server}
        options={choices.server}
        onChange={server => save({ server })}
      />
      <p className="text-xs text-on-surface-variant">
        Larger files download when you click them. Every file you have is shared with the others in
        that conversation while you are online.
      </p>
      <p data-p2p-files-usage className="text-xs text-on-surface-variant">
        {usage
          ? `Attachments here: ${fmtSize(usage.bytes)} (${fmtSize(usage.sent)} sent, ${fmtSize(usage.downloaded)} downloaded).`
          : 'Attachments here: none yet.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-on-surface-variant">
          Clear downloaded attachments older than
        </span>
        {CLEAR_DAYS.map(d => (
          <button key={d} onClick={() => clear(d)} className={textBtn}>
            {d} days
          </button>
        ))}
      </div>
    </div>
  )
}

const LIMIT_ROWS: [UserField, string][] = [
  ['roomBytes', 'Each conversation or server'],
  ['serverBytes', 'All P2P servers'],
  ['totalBytes', 'All direct messages'],
]

// Settings > Peer-to-peer > Advanced: this account's storage budgets and background sync on this
// device, on top of the instance's (the defaults). Read when P2P starts.
function AdvancedLimits() {
  const account = useP2p(s => s.account)
  const info = useStore(s => s.instance)
  const focus = useStore(
    s => s.activeDialog?.kind === 'settings' && s.activeDialog.focus === 'p2p_limits'
  )
  const [, bump] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: 'start' })
  }, [focus])
  if (!account) return null
  const user = readUserLimits(account)
  const base = instanceLocal(info)
  const now = applyUser(base, user)
  const save = (f: UserField | null, n = 0) => {
    writeUserLimits(account, f ? { ...readUserLimits(account), [f]: n } : { v: 1 })
    bump(x => x + 1)
  }
  const select = (f: UserField, label: string) => {
    const def = valueOf(base, f)
    const cur = valueOf(now, f)
    return (
      <AutoSelect
        key={f}
        label={label}
        value={cur}
        options={limitChoices(f, def, cur)}
        text={n => (n === def ? `${limitText(f, n)} (Default)` : limitText(f, n))}
        onChange={n => save(f, n)}
      />
    )
  }
  return (
    <div ref={ref} data-p2p-limits className="flex scroll-mt-4 flex-col gap-2 px-2">
      <p className="text-sm font-medium">Advanced</p>
      <p className="text-xs text-on-surface-variant">Storage on this device</p>
      {LIMIT_ROWS.map(([f, label]) => select(f, label))}
      {select('hiddenPauseMs', 'Keep syncing in the background on phones')}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-on-surface-variant">{LIMITS_LATER}</p>
        <button
          data-p2p-limits-reset
          onClick={() => save(null)}
          disabled={Object.keys(user).length < 2}
          className={`${textBtn} disabled:opacity-40`}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  )
}

const REMOVE_TITLE = 'Remove P2P data from this browser?'
const REMOVE_BODY =
  'Your P2P identity and contacts are deleted from this browser. Without a backup they are gone for good.'

// Settings > Peer-to-peer while the instance has P2P off: only removing this browser's data.
export function P2pOffSection() {
  const username = useStore(s => s.me?.username ?? null)
  const off = useStore(s => !s.settings.p2p)
  const ask = useStore(s => s.askConfirm)
  const [done, setDone] = useState<{ username: string; ok: boolean } | null>(null)
  if (!off || username === null) return null
  const result = done?.username === username ? done : null
  if (result ? result.ok : !p2p.hasData(username)) return null
  const remove = () =>
    ask({
      title: REMOVE_TITLE,
      body: REMOVE_BODY,
      confirm: 'Remove',
      action: () => void p2p.removeData(username).then(ok => setDone({ username, ok })),
    })
  return (
    <section aria-label="Peer-to-peer">
      <p className={sectionCls}>Peer-to-peer</p>
      <div className="flex flex-col items-start gap-2 px-2">
        <p className="text-xs text-on-surface-variant">
          P2P is off on this instance. Your P2P data stays in this browser until you remove it.
        </p>
        {result && (
          <p role="alert" className="text-xs text-error">
            Couldn&apos;t remove P2P data
          </p>
        )}
        <button onClick={remove} className={dangerBtn}>
          Remove P2P data from this browser
        </button>
      </div>
    </section>
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
  const status = useP2p(s => s.status)
  const helpers = useStore(s => s.iceHelpers)
  const setHelpers = useStore(s => s.setIceHelpers)
  const info = useStore(s => s.instance?.ice)
  const ask = useStore(s => s.askConfirm)
  useEffect(() => {
    if (enabled) void p2p.refreshStorage()
  }, [enabled])
  if (!signedIn) return null
  const offer = iceOffer(info)
  const remove = () =>
    ask({
      title: REMOVE_TITLE,
      body: REMOVE_BODY,
      confirm: 'Remove',
      action: () => void p2p.removeData(),
    })
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
          {error && (
            <p role="alert" className="text-xs text-error">
              {error}
            </p>
          )}
          <button onClick={() => p2p.openDialog({ kind: 'enable' })} className={filledBtn}>
            Turn on P2P
          </button>
        </div>
      ) : elsewhere || loading || status === 'moved' ? (
        <div className="flex flex-col gap-4">
          {elsewhere ? (
            <ElsewhereNotice />
          ) : loading ? (
            <p className="px-2 text-sm text-on-surface-variant">Starting…</p>
          ) : (
            <div className="flex flex-col gap-3 px-2">
              <IdentityAlert />
              <MovedBanner />
            </div>
          )}
          <AdvancedLimits />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 px-2 empty:hidden">
            <IdentityAlert />
            <MovingBanner />
          </div>
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
          <BadgeSetting />
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
          <FilesSettings />
          <div className="px-2 text-xs text-on-surface-variant">
            <p className="text-sm font-medium text-on-surface">Storage</p>
            <p data-p2p-storage>
              {storage
                ? `This site uses ${fmtSize(storage.usage)} of ${fmtSize(storage.quota)} in this browser.`
                : 'Storage use is not available in this browser.'}
            </p>
            <DailySelect />
            <p className="mt-1">
              To move to a new device, export from Sync config with Include P2P identity and
              history. Removing this data without that loses your contacts.
            </p>
            <p data-p2p-lost className="mt-1">
              Lost or stolen device? Moving can&apos;t lock it out, because every device holds your
              identity key. Use Reset identity instead: contacts see that your key changed and have
              to verify you again. Remove it from your P2P servers below.
            </p>
          </div>
          <AdvancedLimits />
          <DevicesSection />
          <div className="flex flex-wrap gap-2 px-1">
            <button onClick={() => confirmReset(ask)} className={textBtn}>
              Reset identity
            </button>
            <button onClick={remove} className={dangerBtn}>
              Remove P2P data from this browser
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
