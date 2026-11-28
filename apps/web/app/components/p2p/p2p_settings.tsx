'use client'
import { Name, NameInput } from '../name'
import { instanceName, p2pKey, p2pName, accountLabel, roomName } from '../../lib/names'
import { useAccount } from '../../lib/client/react'
import { confirmIdentityRemoval, identityRecords } from '../../lib/client/identity_enrollment'
import { client } from '../../lib/client/client'
import { P2pProvider, withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../../lib/store'
import { autoChoices } from '../../lib/p2p/app'
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
import { SettingSwitch } from '../settings_fields'
import { Button } from '../controls'
import { Row, Stack, Surface } from '../layout'
import { fieldCls, sectionCls } from '../ui'
import { ServerProfileList, ServerProfileRow } from '../server_profile_list'
import { editsRoomProfile } from '../../lib/server_profile_editor'
import { ownsP2pServer } from '../../lib/p2p/server/types'
import { DevicesSection } from './p2p_server_flows'
import { MyCode } from './add_contact'
import { badgeDate, KeyAvatar, P2pBadge } from './p2p_badge'
import { PictureField } from '../avatar_upload'
import { useP2pPictureMaker } from '../../lib/client/p2p_picture'
import { identityPerson } from '../../lib/people'
import {
  confirmResetFor,
  ElsewhereNotice,
  IdentityAlert,
  MovedBanner,
  MovingBanner,
} from './p2p_home'
import { LabelText, useInstanceLabel } from '../instance_badge'
import { time } from '../../lib/platform/time'

function NameField() {
  const identity = useP2pApp()!
  const { p2p } = identity

  const name = useP2p(s => s.name)
  const [value, setValue] = useState(name)
  useEffect(() => setValue(name), [name])
  const clean = cleanName(value)
  return (
    <Row gap="sm" align="stretch">
      <NameInput
        value={value}
        maxLength={32}
        onChange={e => setValue(e.target.value)}
        aria-label="P2P display name"
      />
      <Button onClick={() => void p2p.setName(value)} disabled={!clean || clean === name}>
        Save
      </Button>
    </Row>
  )
}

// The picture of this P2P identity: contacts and the members of its servers see it.
function PictureRow() {
  const identity = useP2pApp()!
  const { p2p } = identity
  const me = useP2p(s => s.ik)
  const has = useP2p(s => s.pic !== null)
  const maker = useP2pPictureMaker()
  if (!me) return null
  return (
    <PictureField
      avatar={<KeyAvatar person={identityPerson(me, 'own')} size={48} />}
      note="Your contacts and the members of your P2P servers see it. Your key's identicon shows while it loads."
      source={{
        off: maker.off,
        maxBytes: maker.maxBytes,
        has,
        upload: async (file, crop) => {
          const made = await maker.make(file, crop)
          if (typeof made === 'string') return made
          await p2p.setPic(made)
          return null
        },
        remove: async () => {
          await p2p.setPic(null)
          return null
        },
      }}
    />
  )
}

function P2pProfileRow({ room }: { room: string }) {
  const identity = useP2pApp()!
  const account = useAccount()
  const closeSettings = useStore(s => s.closeDialog)
  const v = useP2p(s => s.servers[room])
  const own = useP2p(s => ownsP2pServer(v, s.me))
  if (!v) return null
  return (
    <ServerProfileRow
      name={roomName(v.name, own)}
      onEdit={() => {
        closeSettings()
        account.identities.show(identity)
        identity.p2p.openDialog({ kind: 'server_profile', room })
      }}
    />
  )
}

// Your P2P servers that show server profiles, each opening the profile you show only there.
function P2pServerProfiles() {
  const rooms = useP2p(
    useShallow(s =>
      Object.values(s.servers)
        .filter(editsRoomProfile)
        .map(v => v.id)
    )
  )
  if (!rooms.length) return null
  return (
    <Surface pad="sm" inset="bar" tone="plain" radius="none">
      <ServerProfileList>
        {rooms.map(room => (
          <P2pProfileRow key={room} room={room} />
        ))}
      </ServerProfileList>
    </Surface>
  )
}

export const BADGE_ON_BODY =
  'Contacts, people you sent a request to and server members see "Confirmed as" and your account name next to your P2P name. The instance learns your P2P identity key, which links your P2P activity to your account. While this is on, it renews the confirmation every day.'

export const badgeOffBody = (until: number | null) =>
  `Peers who already have your confirmation keep showing it until it expires${
    until ? `, on ${badgeDate(until)}` : ''
  }, at most 7 days from now. They may then show it as expired for up to 30 days. P2P servers you joined keep the old confirmation in their history.`

// Settings > Peer-to-peer > Account badge (opt-in).
function BadgeSetting() {
  const identity = useP2pApp()!
  const { p2pBadge } = identity

  const { label } = useInstanceLabel()
  const badge = useP2p(s => s.badge)
  const busy = useP2p(s => s.badgeBusy)
  const error = useP2p(s => s.badgeError)
  const ik = useP2p(s => s.ik)
  const ask = useStore(s => s.askConfirm)
  const on = !!badge?.on
  const live = on && !!badge?.token && badge.ik === ik
  const tail = !on && badge && badge.exp * 1000 > time().now() ? badge.exp * 1000 : null
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
    <Stack data-p2p-badge-setting gap="none">
      <SettingSwitch label="Account badge" value={on} onChange={change} disabled={busy} />
      <Surface pad="sm" inset="bar" tone="plain" radius="none">
        <p className="text-xs text-on-surface-variant">
          {busy ? (
            'Asking the instance…'
          ) : live && badge ? (
            <>
              Shown as <Name of={accountLabel(badge.sub)} />. Renewed every day.
            </>
          ) : on ? (
            'On. Waiting for the instance to confirm it.'
          ) : tail ? (
            `Off. Peers who have it may show it until ${badgeDate(tail)}.`
          ) : (
            <>
              Lets contacts see which account on <Name of={instanceName(label)} /> holds your P2P
              identity. Off by default.
            </>
          )}
        </p>
      </Surface>
      {error && (
        <Surface pad="sm" inset="bar" tone="plain" radius="none">
          <p role="alert" className="text-xs text-error">
            <LabelText text={error} />
          </p>
        </Surface>
      )}
    </Stack>
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
    <Row gap="sm" justify="between" wrap>
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
    </Row>
  )
}

const CLEAR_DAYS = [7, 30, 90]

// Settings > Peer-to-peer > Storage: how much one contact's files may download by themselves a
// day.
function DailySelect() {
  const identity = useP2pApp()!
  const { p2pFiles } = identity

  const info = useStore(s => s.instance)
  const [daily, setDaily] = useState(() => p2pFiles.readAuto().daily)
  return (
    <Stack data-p2p-daily gap="2xs">
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
      <p>
        Past it, or when this device has less than 10% of its storage (at least 512 MB) free, files
        wait for you to click them.
      </p>
    </Stack>
  )
}

// Settings > Peer-to-peer > Attachments: what downloads by itself, what is stored here, and
// clearing old downloads.
function FilesSettings() {
  const identity = useP2pApp()!
  const { p2pFiles } = identity

  const { label } = useInstanceLabel()
  const usage = useP2p(s => s.fileUsage)
  const textOnly = useStore(s => !s.settings.asset_uploads && !s.settings.p2p_attachments)
  const ask = useStore(s => s.askConfirm)
  const { toast } = identity.p2pHost
  const info = useStore(s => s.instance)
  const [auto, setAuto] = useState(p2pFiles.readAuto)
  const choices = autoChoices(instanceLocal(info))
  useEffect(() => {
    void p2pFiles.usage()
  }, [])
  if (textOnly)
    return (
      <Surface pad="sm" inset="bar" tone="plain" radius="none">
        <p className="text-xs text-on-surface-variant">
          Attachments are turned off on <Name of={instanceName(label)} />, so P2P files are hidden
          too.
        </p>
      </Surface>
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
    <Surface data-p2p-files pad="sm" inset="bar" gap="sm" tone="plain" radius="none">
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
      <Row gap="sm" wrap>
        <span className="text-xs text-on-surface-variant">
          Clear downloaded attachments older than
        </span>
        {CLEAR_DAYS.map(d => (
          <Button key={d} onClick={() => clear(d)}>
            {d} days
          </Button>
        ))}
      </Row>
    </Surface>
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
  const limitsOwner = useAccount()
  const limitsIdentity = useP2pApp()!

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
  const user = readUserLimits(account, limitsOwner.conn, limitsIdentity.localId)
  const base = instanceLocal(info)
  const now = applyUser(base, user)
  const save = (f: UserField | null, n = 0) => {
    writeUserLimits(
      account,
      f
        ? { ...readUserLimits(account, limitsOwner.conn, limitsIdentity.localId), [f]: n }
        : { v: 1 },
      limitsOwner.conn,
      limitsIdentity.localId
    )
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
    <div ref={ref} data-p2p-limits className="scroll-mt-4">
      <Surface pad="sm" inset="bar" gap="sm" tone="plain" radius="none">
        <p className="text-sm font-medium">Advanced</p>
        <p className="text-xs text-on-surface-variant">Storage on this device</p>
        {LIMIT_ROWS.map(([f, label]) => select(f, label))}
        {select('hiddenPauseMs', 'Keep syncing in the background on phones')}
        <Row gap="sm" justify="between" wrap>
          <p className="text-xs text-on-surface-variant">{LIMITS_LATER}</p>
          <Button
            data-p2p-limits-reset
            onClick={() => save(null)}
            disabled={Object.keys(user).length < 2}
          >
            Reset to defaults
          </Button>
        </Row>
      </Surface>
    </div>
  )
}

// Settings > Peer-to-peer while the instance has P2P off: only removing this browser's data.
export function P2pOffSection() {
  const account = useAccount()

  const { label } = useInstanceLabel()
  const username = useStore(s => s.me?.username ?? null)
  const off = useStore(s => !s.settings.p2p)

  const guest = useStore(s => s.guest)
  const session = account.lifetime.sessionMark()
  const [done, setDone] = useState<{ session: object; username: string; ok: boolean } | null>(null)
  if (!off || guest || username === null) return null
  const data = account.identities.offlineData()
  const nameOf = (id: string) =>
    identityRecords(client.book.getState(), account.conn.origin, username)?.find(
      peer => peer.local === id
    )?.name ?? id
  const result = done?.session === session && done.username === username ? done : null
  if (!result && !data.length) return null
  const remove = (slot: (typeof data)[number]) =>
    confirmIdentityRemoval(account, account, slot.id, ok => setDone({ session, username, ok }))
  return (
    <section aria-label="Peer-to-peer">
      <p className={sectionCls}>Peer-to-peer</p>
      <Surface pad="sm" inset="bar" gap="sm" tone="plain" radius="none" align="start">
        <p className="text-xs text-on-surface-variant">
          P2P is off on <Name of={instanceName(label)} />. Your P2P data stays on this device until
          you remove it.
        </p>
        {result &&
          (result.ok ? (
            <p role="status" className="text-xs text-on-surface">
              P2P data removed from this browser.
            </p>
          ) : (
            <p role="alert" className="text-xs text-error">
              Couldn&apos;t remove P2P data
            </p>
          ))}
        {data.map(slot => (
          <Button key={slot.id} variant="danger" onClick={() => remove(slot)}>
            {slot.id === 'main' ? (
              'Remove P2P data from this browser'
            ) : (
              <>
                Remove P2P data for <Name of={p2pName(nameOf(slot.id))} /> from this browser
              </>
            )}
          </Button>
        ))}
      </Surface>
    </section>
  )
}

// Settings > Peer-to-peer. Off until the user turns it on; only for signed-in accounts.
function P2pSectionBody() {
  const identity = useP2pApp()!
  const { p2p } = identity

  const account = useAccount()
  const username = useStore(s => s.me?.username)
  const record = useSyncExternalStore(
    client.book.subscribe,
    () =>
      username
        ? identityRecords(client.book.getState(), account.conn.origin, username)?.find(
            i => i.local === identity.localId
          )
        : undefined,
    () => undefined
  )
  const name = useP2p(s => s.name)
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
  const remove = () => confirmIdentityRemoval(account, account, identity.localId)
  return (
    <section aria-label="Peer-to-peer">
      <div className={sectionCls}>
        <Row as="p" gap="sm">
          Peer-to-peer <P2pBadge />{' '}
          {enabled && <Name of={p2pName(name || record?.name || identity.localId, true)} />}
        </Row>
      </div>
      {!enabled ? (
        <Surface pad="sm" inset="bar" gap="sm" tone="plain" radius="none" align="start">
          <p className="text-xs text-on-surface-variant">
            Contacts you add by code, connected straight to you. Off by default.
          </p>
          {error && (
            <p role="alert" className="text-xs text-error">
              <LabelText text={error} />
            </p>
          )}
          <Button
            variant="filled"
            size="md"
            onClick={() => {
              account.identities.show(identity)
              p2p.openDialog({ kind: 'enable' })
            }}
          >
            Turn on P2P
          </Button>
        </Surface>
      ) : elsewhere || loading || status === 'moved' ? (
        <Stack gap="lg">
          {elsewhere ? (
            <ElsewhereNotice />
          ) : loading ? (
            <Surface pad="sm" inset="bar" tone="plain" radius="none">
              <p className="text-sm text-on-surface-variant">Starting…</p>
            </Surface>
          ) : (
            <Surface pad="sm" inset="bar" gap="md" tone="plain" radius="none">
              <IdentityAlert />
              <MovedBanner />
            </Surface>
          )}
          <AdvancedLimits />
        </Stack>
      ) : (
        <Stack gap="lg">
          <Surface pad="sm" inset="sides" gap="md" tone="plain" radius="none" look="empty:hidden">
            <IdentityAlert />
            <MovingBanner />
          </Surface>
          {error && (
            <Surface pad="sm" inset="bar" tone="plain" radius="none">
              <p role="alert" className="text-xs text-error">
                <LabelText text={error} />
              </p>
            </Surface>
          )}
          <Surface pad="sm" inset="bar" gap="sm" tone="plain" radius="none">
            <p className="text-sm font-medium">Your contact code</p>
            <MyCode />
          </Surface>
          <Surface pad="sm" inset="bar" gap="2xs" tone="plain" radius="none">
            <p className="text-sm font-medium">Name shown to contacts</p>
            <NameField />
            <Name
              as="p"
              of={p2pKey(fp)}
              before="Key "
              look="font-mono text-2xs text-on-surface-variant"
            />
          </Surface>
          <Surface pad="sm" inset="bar" gap="sm" tone="plain" radius="none">
            <PictureRow />
          </Surface>
          <P2pServerProfiles />
          <BadgeSetting />
          <Stack gap="none">
            <SettingSwitch
              label="Pause P2P"
              value={paused}
              onChange={on => void p2p.setPaused(on)}
            />
            <Surface pad="sm" inset="bar" tone="plain" radius="none">
              <p className="text-xs text-on-surface-variant">
                Stops every P2P connection. Nothing is delivered while paused.
              </p>
            </Surface>
          </Stack>
          <Stack gap="none">
            <SettingSwitch label="Use connection helpers" value={helpers} onChange={setHelpers} />
            <Surface pad="sm" inset="bar" tone="plain" radius="none">
              <p className="text-xs text-on-surface-variant">
                {helpers && offer.length
                  ? `In use: ${offer.join(', ')}.`
                  : 'None: direct connections only, same network.'}{' '}
                The instance can see when you are online and who you connect to, not what you say.
                While you are offline, anyone with your code can take your P2P address and see when
                your contacts try to reach you, and from which IP unless helpers relay everything.
              </p>
            </Surface>
          </Stack>
          <FilesSettings />
          <div className="text-xs text-on-surface-variant">
            <Surface pad="sm" inset="bar" gap="sm" tone="plain" radius="none">
              <Stack gap="none">
                <p className="text-sm font-medium text-on-surface">Storage</p>
                <p data-p2p-storage>
                  {storage
                    ? `This site uses ${fmtSize(storage.usage)} of ${fmtSize(storage.quota)} in this browser.`
                    : 'Storage use is not available in this browser.'}
                </p>
              </Stack>
              <Stack gap="2xs">
                <DailySelect />
                <p>
                  To move to a new device, export from Sync config with Include P2P identity and
                  history. Removing this data without that loses your contacts.
                </p>
                <p data-p2p-lost>
                  Lost or stolen device? Moving can&apos;t lock it out, because every device holds
                  your identity key. Use Reset identity instead: contacts see that your key changed
                  and have to verify you again. Remove it from your P2P servers below.
                </p>
              </Stack>
            </Surface>
          </div>
          <AdvancedLimits />
          <DevicesSection />
          <Surface pad="2xs" tone="plain" radius="none">
            <Row gap="sm" align="stretch" wrap>
              <Button onClick={() => confirmResetFor(identity)(ask)}>Reset identity</Button>
              <Button variant="danger" onClick={remove}>
                Remove P2P data from this browser
              </Button>
            </Row>
          </Surface>
        </Stack>
      )}
    </section>
  )
}

const IdentitySettings = withP2pIdentity(P2pSectionBody)

export function P2pSection() {
  const account = useAccount()
  const snapshot = () =>
    account.identities
      .list()
      .map(app => app.localId)
      .join(',')
  const ids = useSyncExternalStore(account.identities.subscribe, snapshot, snapshot)
  const apps = ids ? ids.split(',').map(id => account.identities.get(id)!) : []
  if (!apps.length) return null
  return (
    <>
      {apps.map(app => (
        <P2pProvider key={app.localId} identity={app}>
          <IdentitySettings />
        </P2pProvider>
      ))}
      <Button onClick={() => account.identities.viewed()?.p2p.openDialog({ kind: 'enable' })}>
        Add a P2P identity
      </Button>
    </>
  )
}
