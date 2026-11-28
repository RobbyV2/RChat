'use client'
import { buttonLook } from '../lib/controls'
import { OwnLoadNotice } from './own_load'
import { Name } from './name'
import { instanceAddress, instanceName, personCalled, handleName, serverName } from '../lib/names'
import { asAccount, pictured } from '../lib/people'
import { DeviceKeySection } from './p2p/device_key'
import { useP2p } from '../lib/client/p2p_react'

import { SignInLinks, SignInMethods } from './sso/sign_in_methods'
import { useConfirmation } from './sso/use_confirmation'
import { ReAuthPrompt } from './backup_phrase/reauth_prompt'
import { PhraseSettings } from './backup_phrase/phrase_settings'
import { DeleteAccount } from './account_deletion'
import type { LinkedProvider, ReAuthBody } from '../lib/types'
import { ManageAccounts, SettingsAccountPicker } from './account_switcher'
import { client } from '../lib/client/client'
import { useAccount } from '../lib/client/react'

import { AnnouncementSetting } from './announcements'
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import Link from 'next/link'
import {
  Bell,
  Command,
  Globe,
  Info as InfoIcon,
  Network,
  Pencil,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import { useStore } from '../lib/store'
import { limitsOf } from '../lib/instance_limits'
import { iceOffer } from '../lib/ice'
import { ownTurn } from '../lib/relays'
import { RelaySection } from './relay_settings'
import { P2pOffSection, P2pSection } from './p2p/p2p_settings'

import {
  SECTION_GROUPS,
  SECTION_LABELS,
  sectionFor,
  settingsRows,
  settingsSections,
  type SettingsSection,
} from '../lib/settings_sections'
import { avatarColorFor, avatarDraft } from '../lib/identicon'
import { defaultBanner } from '../lib/profile'
import { passwordChangeError, secretOf, type PassKind } from '../lib/password'
import { capabilities, desktopInfo, inShell } from '../lib/platform'
import { filterSwitch } from '../lib/profanity'
import { BIO_MAX, bioAnnouncement, bioError, charCount, cleanBio, siteFilterOn } from '../lib/rules'
import { SHORTCUTS, shortcutLabel, type Shortcut } from '../lib/shortcuts'
import { shownParts } from '../lib/server_profile'
import type { AvatarKind, ServerSummary } from '../lib/types'
import { AvatarPicker } from './avatar_picker'
import { ServerProfileList, ServerProfileRow } from './server_profile_list'
import { DisplayNameField } from './display_name'
import { canEditDisplayName } from '../lib/display_name'
import { ColorField } from './color_field'
import { InstanceDetails, useInstanceLabel } from './instance_badge'
import { UserAvatar } from './user_avatar'
import { AnimationsSetting } from './animations_setting'
import { SettingNotes, SettingSwitch } from './settings_fields'
import { Button, LinkButton } from './controls'
import { Row, Stack, Surface, Grid, Lift } from './layout'
import { NotificationsSection } from './notify_settings'
import { ConfigSyncSection } from './config_sync'
import { DocsEntry } from './docs_entry'
import { DesktopSection } from './desktop_settings'
import { BlockedUsersSection } from './blocking'
import { PaletteSettingsSection } from './palette_settings'
import { Choice, PrivacyChoices } from './friends'
import { LinkSafetySection } from './link_safety_settings'
import { AccountWords, PassSwitch } from './word_grid'
import { PageRow, SettingsPage, type PageSection } from './settings_page'
import { Dialog, FieldError, fieldCls, sectionCls } from './ui'

const bioFieldCls = fieldCls.replace(' border-outline', '').replace(' focus:border-primary', '')

export default function SettingsMenu() {
  const open = useStore(s => s.activeDialog?.kind === 'settings')
  return open ? <Menu /> : null
}

// `fallback` is the banner that shows while none is chosen here, when that is not the default of
// the avatar (a server profile falls back to the account's banner). `avatar` draws the preview's
// picture in place of the account avatar.
export function BannerPicker({
  username,
  displayName,
  kind,
  avatarColor,
  banner,
  onBanner,
  fallback = null,
  avatar,
  defaultNote = 'Default, follows your avatar',
  resetLabel = 'Use default',
}: {
  username: string
  displayName: string
  kind: AvatarKind
  avatarColor: string | null
  banner: string | null
  onBanner: (color: string | null) => void
  fallback?: string | null
  avatar?: React.ReactNode
  defaultNote?: string
  resetLabel?: string
}) {
  const shown =
    banner ?? fallback ?? defaultBanner({ username, avatar_kind: kind, avatar_color: avatarColor })
  return (
    <Stack gap="sm">
      <span className="text-sm text-on-surface-variant">Banner</span>
      <div className="overflow-hidden rounded-2xl bg-surface-container-high" aria-hidden>
        <div style={{ background: shown }} className="h-14" />
        <Lift by="3xl">
          <Surface pad="md" tone="plain">
            <Row gap="md" align="end">
              <Surface as="span" pad="2xs" tone="high" radius="full" place="shrink-0">
                {avatar ?? (
                  <UserAvatar
                    person={pictured(username, { kind, color: avatarColor }, 'editor')}
                    size={56}
                  />
                )}
              </Surface>
              <Name
                of={personCalled(displayName, null, true)}
                look="truncate font-medium text-on-surface"
              />
            </Row>
          </Surface>
        </Lift>
      </div>
      <ColorField
        label="Banner color"
        value={banner}
        shown={shown}
        onChange={onBanner}
        defaultNote={defaultNote}
        resetLabel={resetLabel}
      />
    </Stack>
  )
}

function HostedProfileRow({ server }: { server: ServerSummary }) {
  const openDialog = useStore(s => s.openDialog)
  return (
    <ServerProfileRow
      name={serverName(server)}
      onEdit={() => openDialog({ kind: 'server_profile', server: server.name })}
    />
  )
}

// Your servers that show server profiles, each opening the profile you show only there.
function ServerProfiles() {
  const servers = useStore(
    useShallow(s => s.me?.servers.filter(x => shownParts(s, x.name).rest) ?? [])
  )
  const more = useStore(s => s.serversMore)
  const loadMore = useStore(s => s.loadMoreServers)
  const on = useStore(s => s.settings.server_profiles !== false)
  if (!on || (!servers.length && !more)) return null
  return (
    <ServerProfileList more={more ? () => void loadMore() : null}>
      {servers.map(s => (
        <HostedProfileRow key={s.name} server={s} />
      ))}
    </ServerProfileList>
  )
}

function AboutMe({ focus }: { focus: boolean }) {
  const { store } = useAccount()
  const saved = useStore(s => s.me?.bio ?? '')
  const setBio = useStore(s => s.setBio)
  const [text, setText] = useState(saved)
  const [seen, setSeen] = useState(saved)
  if (seen !== saved) {
    setSeen(saved)
    if (text === seen) setText(saved)
  }
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const id = useId()

  useEffect(() => {
    const el = ref.current
    if (!focus || !el) return
    el.scrollIntoView({ block: 'center' })
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [focus])

  const count = charCount(cleanBio(text))
  const over = count > BIO_MAX
  const changed = cleanBio(text) !== saved

  const save = async () => {
    const invalid = bioError(text)
    if (invalid) {
      setError(invalid)
      return
    }
    setBusy(true)
    const err = await setBio(text)
    setBusy(false)
    setError(err)
    if (err) return
    setDone(true)
    setText(store.getState().me?.bio ?? '')
  }

  const cancel = () => {
    setText(saved)
    setError(null)
    setDone(false)
  }

  return (
    <Stack gap="sm">
      <label htmlFor={id} className="text-sm text-on-surface-variant">
        About me
      </label>
      <textarea
        id={id}
        ref={ref}
        rows={4}
        value={text}
        onChange={e => {
          setText(e.target.value)
          setError(null)
          setDone(false)
        }}
        placeholder="Tell people a little about yourself"
        aria-invalid={over || error !== null}
        aria-describedby={error ? `${id}-count ${id}-error` : `${id}-count`}
        className={`${bioFieldCls} resize-none ${
          over || error !== null ? 'border-error' : 'border-outline focus:border-primary'
        }`}
      />
      <Row gap="md" align="start" justify="between" place="relative">
        <div className="min-w-0">
          <FieldError id={`${id}-error`} message={error} />
          {done && !error && <p className="text-xs text-on-surface-variant">Saved</p>}
        </div>
        <span aria-live="polite" className="sr-only">
          {bioAnnouncement(count, done && !error)}
        </span>
        <span
          id={`${id}-count`}
          className={`shrink-0 text-xs tabular-nums ${over ? 'text-error' : 'text-on-surface-variant'}`}
        >
          {count}/{BIO_MAX}
        </span>
      </Row>
      <Row gap="sm" justify="end">
        <Button type="button" onClick={cancel} disabled={text === saved}>
          Cancel
        </Button>
        <Button
          variant="filled"
          size="md"
          type="button"
          onClick={() => void save()}
          disabled={busy || over || !changed}
        >
          Save
        </Button>
      </Row>
    </Stack>
  )
}

// The top of Profile: who is signed in, and on which instance.
function AccountCard() {
  const me = useStore(s => s.me)
  const { label, host } = useInstanceLabel()
  return (
    <Surface data-account-card pad="lg" gap="md">
      <Row gap="md">
        {me ? <UserAvatar person={asAccount(me, 'own')} size={48} /> : <GuestAvatar size={48} />}
        <div className="min-w-0">
          <Name
            as="p"
            of={personCalled(me ? me.display_name : 'Guest', null, true)}
            look="truncate font-medium text-on-surface"
          />
          {me ? (
            <Name
              as="p"
              of={handleName(me.username, true)}
              before="@"
              look="truncate text-sm text-on-surface-variant"
            />
          ) : (
            <p className="truncate text-sm text-on-surface-variant">Browsing without an account</p>
          )}
        </div>
      </Row>
      <div aria-hidden className="border-t border-outline-variant" />
      <Row gap="md">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-container text-on-primary-container">
          <Globe size={16} />
        </span>
        <div className="min-w-0">
          <Name
            as="p"
            of={instanceName(label)}
            look="truncate text-sm font-medium text-on-surface"
          />
          {host !== label && (
            <Name
              as="p"
              of={instanceAddress(host)}
              look="truncate text-xs text-on-surface-variant"
            />
          )}
        </div>
      </Row>
    </Surface>
  )
}

function GuestAvatar({ size }: { size: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container"
    >
      <UserRound size={size / 2} />
    </span>
  )
}

// The top of the nav: the account the settings belong to, and the other accounts to pick.
function NavAccount({
  section,
  onProfile,
}: {
  section: SettingsSection | null
  onProfile: () => void
}) {
  const me = useStore(s => s.me)
  const { label, host } = useInstanceLabel()
  return (
    <Surface data-nav-account pad="2xs" gap="sm" tone="plain">
      <Row gap="md">
        {me ? <UserAvatar person={asAccount(me, 'own')} size={40} /> : <GuestAvatar size={40} />}
        <div className="min-w-0">
          <Name
            as="p"
            of={personCalled(me ? me.display_name : 'Guest', null, true)}
            look="truncate text-sm font-medium text-on-surface"
          />
          <Name as="p" of={instanceName(label)} look="truncate text-xs text-on-surface-variant" />
          {host !== label && (
            <Name
              as="p"
              of={instanceAddress(host)}
              look="truncate text-xs text-on-surface-variant"
            />
          )}
          {me && (
            <LinkButton onClick={onProfile}>
              <Pencil size={12} />
              Edit your profile
            </LinkButton>
          )}
        </div>
      </Row>
      <SettingsAccountPicker section={section} />
    </Surface>
  )
}

function ProfileFields() {
  const focusBio = useStore(
    s => s.activeDialog?.kind === 'settings' && s.activeDialog.focus === 'bio'
  )
  const focusName = useStore(
    s => s.activeDialog?.kind === 'settings' && s.activeDialog.focus === 'display_name'
  )
  const editName = useStore(canEditDisplayName)
  const me = useStore(s => s.me)
  const patchMe = useStore(s => s.patchMe)
  const [draft] = useState(() => avatarDraft(me))
  const [kind, setKind] = useState<AvatarKind>(draft.kind)
  const [color, setColor] = useState(draft.color)
  const [background, setBackground] = useState(draft.background)
  const [banner, setBanner] = useState<string | null>(me?.banner_color ?? null)
  if (!me) return null
  return (
    <PageRow id="user_profile">
      <p className={sectionCls}>Your profile</p>
      <Stack gap="xl">
        <Stack gap="lg">
          {editName && <DisplayNameField focus={focusName} />}
          <AvatarPicker
            username={me.username}
            kind={kind}
            color={color}
            onKind={setKind}
            onColor={setColor}
            background={background}
            onBackground={setBackground}
          />
          <BannerPicker
            username={me.username}
            displayName={me.display_name}
            kind={kind}
            avatarColor={kind === 'color' ? color : background}
            banner={banner}
            onBanner={setBanner}
          />
          <Button
            variant="filled"
            size="md"
            onClick={() => void patchMe(kind, avatarColorFor(kind, color, background), banner)}
            place="self-start"
          >
            Save profile
          </Button>
        </Stack>
        <AboutMe focus={focusBio} />
        <ServerProfiles />
      </Stack>
    </PageRow>
  )
}

const NO_LINKS: LinkedProvider[] = []

function SecretField({
  label,
  kind,
  onKind,
  username,
  selected,
  onSelected,
  children,
}: {
  label: string
  kind: PassKind
  onKind: (kind: PassKind) => void
  username: string
  selected: string[]
  onSelected: (selected: string[]) => void
  children: React.ReactNode
}) {
  return (
    <Stack gap="sm">
      <span className="text-sm text-on-surface-variant">{label}</span>
      <PassSwitch value={kind} onChange={onKind} label={`${label} type`} />
      {kind === 'text' ? (
        children
      ) : (
        <AccountWords username={username} selected={selected} onChange={onSelected} />
      )}
    </Stack>
  )
}

function PasswordSection({ links }: { links: LinkedProvider[] }) {
  const currentDialog = useConfirmation()
  const first = useStore(s => s.me?.has_password === false)
  const allowed = useStore(
    s => s.instance?.auth?.password_login === true && s.settings.password_login
  )
  const [confirming, setConfirming] = useState(false)
  const title = first ? 'Set a password' : 'Change password'
  const username = useStore(s => s.me?.username)
  const savedKind = useStore(s => s.me?.password_kind ?? 'text')
  const changePassword = useStore(s => s.changePassword)
  const refreshAccount = useStore(s => s.refreshAccount)
  const [currentKind, setCurrentKind] = useState<PassKind>(savedKind)
  const [newKind, setNewKind] = useState<PassKind>(savedKind)
  const [seenKind, setSeenKind] = useState<PassKind>(savedKind)
  if (seenKind !== savedKind) {
    setSeenKind(savedKind)
    if (currentKind === seenKind) setCurrentKind(savedKind)
    if (newKind === seenKind) setNewKind(savedKind)
  }
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [currentWords, setCurrentWords] = useState<string[]>([])
  const [newWords, setNewWords] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refreshAccount()
  }, [refreshAccount])

  if (!username || (first && !allowed)) return null

  const edit =
    <T,>(fn: (v: T) => void) =>
    (v: T) => {
      fn(v)
      setError(null)
      setDone(false)
    }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const invalid = passwordChangeError(
      {
        currentKind,
        current,
        currentWords,
        newKind,
        next,
        confirm,
        newWords,
      },
      first
    )
    if (invalid) {
      setError(invalid)
      return
    }
    if (first) {
      setConfirming(true)
      return
    }
    await save()
  }
  const save = async (reauth?: ReAuthBody) => {
    if (!currentDialog()) return
    setBusy(true)
    const err = await changePassword(
      first ? undefined : secretOf(currentKind, current, currentWords),
      secretOf(newKind, next, newWords),
      newKind,
      reauth
    )
    if (!currentDialog()) return
    setBusy(false)
    setConfirming(false)
    setError(err)
    if (err) return
    setDone(true)
    setCurrentKind(newKind)
    setCurrent('')
    setNext('')
    setConfirm('')
    setCurrentWords([])
    setNewWords([])
  }

  return (
    <Stack gap="md">
      <p className="text-sm font-medium text-on-surface">{title}</p>
      <OwnLoadNotice
        what="account"
        lead="Could not check how you sign in. This shows what this device last knew."
        retry={() => void refreshAccount()}
      />
      <Stack as="form" onSubmit={submit} gap="lg">
        <input
          type="text"
          value={username}
          readOnly
          hidden
          autoComplete="username"
          aria-hidden
          tabIndex={-1}
        />
        {!first && (
          <SecretField
            label="Current password"
            kind={currentKind}
            onKind={edit(setCurrentKind)}
            username={username}
            selected={currentWords}
            onSelected={edit(setCurrentWords)}
          >
            <input
              type="password"
              value={current}
              onChange={e => edit(setCurrent)(e.target.value)}
              autoComplete="current-password"
              placeholder="Current password"
              aria-label="Current password"
              className={fieldCls}
            />
          </SecretField>
        )}
        <SecretField
          label="New password"
          kind={newKind}
          onKind={edit(setNewKind)}
          username={username}
          selected={newWords}
          onSelected={edit(setNewWords)}
        >
          <input
            type="password"
            value={next}
            onChange={e => edit(setNext)(e.target.value)}
            autoComplete="new-password"
            placeholder="New password"
            aria-label="New password"
            className={fieldCls}
          />
          <input
            type="password"
            value={confirm}
            onChange={e => edit(setConfirm)(e.target.value)}
            autoComplete="new-password"
            placeholder="Confirm new password"
            aria-label="Confirm new password"
            className={fieldCls}
          />
        </SecretField>
        <Stack gap="md">
          <Stack gap="xs">
            <p className="text-xs text-on-surface-variant">
              Other devices and browsers are signed out when you change your password.
            </p>
            <FieldError message={error} />
            {done && (
              <p role="status" className="text-xs text-primary">
                Password changed
              </p>
            )}
          </Stack>
          <Button type="submit" variant="filled" size="md" disabled={busy} place="self-start">
            {title}
          </Button>
        </Stack>
      </Stack>
      {confirming && first && (
        <Dialog
          title="Set a password"
          compact
          layer="confirm"
          onClose={() => {
            if (!busy) setConfirming(false)
          }}
        >
          <ReAuthPrompt
            purpose="set_password"
            links={links}
            ways={['idp', 'phrase']}
            onBody={save}
          />
        </Dialog>
      )}
    </Stack>
  )
}

function AccountMethods() {
  const phrase = useStore(
    s => s.settings.backup_phrase && s.me?.password_temporary?.change !== 'required'
  )
  return (
    <SignInLinks>
      {(links, list) => (
        <>
          <PasswordSection links={links ?? NO_LINKS} />
          <SignInMethods links={links} list={list} />
          {phrase && <PhraseSettings links={links ?? NO_LINKS} />}
          <DeleteAccount links={links ?? NO_LINKS} />
        </>
      )}
    </SignInLinks>
  )
}

function SignInSection() {
  const shownVersion = useSyncExternalStore(
    client.subscribe,
    client.shownVersion,
    client.shownVersion
  )
  const acct = useAccount()
  const dialog = useStore(s => s.activeDialog)
  const username = useStore(s => s.me?.username)
  const mark = acct.lifetime.sessionMark()
  const [seenMark, setSeenMark] = useState(mark)
  const [seen, setSeen] = useState(dialog)
  const [generation, setGeneration] = useState(0)
  if (seen !== dialog || seenMark !== mark) {
    setSeenMark(mark)
    setSeen(dialog)
    setGeneration(generation + 1)
  }
  const accountKey = JSON.stringify([acct.conn.origin, username, generation, shownVersion])
  const signedIn = useStore(s => s.me !== null && !s.guest)
  const logout = useStore(s => s.logout)
  const closeDialog = useStore(s => s.closeDialog)
  return (
    <section>
      <p className={sectionCls}>Sign-in</p>
      <Stack gap="xl" align="start">
        {signedIn && <AccountMethods key={accountKey} />}
        <Link
          href="/login"
          replace
          data-settings-logout
          onClick={() => {
            closeDialog()
            logout()
          }}
          className={`inline-flex items-center ${buttonLook('danger', 'sm')}`}
        >
          {signedIn ? 'Log out' : 'Exit guest mode'}
        </Link>
      </Stack>
    </section>
  )
}

function StatusSection() {
  const appearOffline = useStore(s => s.me?.appear_offline)
  const setAppearOffline = useStore(s => s.setAppearOffline)
  if (appearOffline === undefined) return null
  return (
    <PageRow id="user_status">
      <section>
        <p className={sectionCls}>Status</p>
        <SettingSwitch
          label="Appear offline"
          value={appearOffline}
          onChange={v => void setAppearOffline(v)}
        />
        <SettingNotes>
          <p className="text-xs text-on-surface-variant">
            You will never appear online to others. You can still chat normally.
          </p>
        </SettingNotes>
      </section>
    </PageRow>
  )
}

function ChatSection() {
  const on = useStore(s => s.typingOn)
  const setOn = useStore(s => s.setTypingOn)
  const shown = useStore(s => s.me !== null || s.guest)
  if (!shown) return null
  return (
    <section>
      <p className={sectionCls}>Chat</p>
      <Stack gap="sm">
        <PageRow id="user_typing">
          <SettingSwitch label="Typing indicators" value={on} onChange={setOn} />
          <SettingNotes>
            <p className="text-xs text-on-surface-variant">
              Show when others are typing and let them see when you type. Off hides both.
            </p>
          </SettingNotes>
        </PageRow>
        <PageRow id="user_profanity">
          <ProfanitySwitch />
        </PageRow>
        <PageRow id="user_spoilers">
          <SpoilersChoice />
        </PageRow>
      </Stack>
    </section>
  )
}

const SPOILER_CHOICES = [
  { value: 'click', label: 'On click' },
  { value: 'always', label: 'Always' },
] as const

function SpoilersChoice() {
  const show = useStore(s => s.showSpoilers)
  const setShow = useStore(s => s.setShowSpoilers)
  return (
    <SettingNotes>
      <Choice label="Show spoilers" value={show} options={SPOILER_CHOICES} onChange={setShow} />
      <p className="text-xs text-on-surface-variant">
        Always shows spoiler text and attachments without a click, except in streamer mode. Previews
        and notifications keep them hidden.
      </p>
    </SettingNotes>
  )
}

export function ProfanitySwitch() {
  const on = useStore(s => s.profanityOn)
  const setOn = useStore(s => s.setProfanityOn)
  const failed = useStore(s => s.profanityFailed)
  const site = useStore(s => siteFilterOn(s.settings))
  const { label } = useInstanceLabel()
  const shown = filterSwitch(capabilities().wasm, on, failed)
  return (
    <div>
      <SettingSwitch
        label="Filter profanity"
        value={shown.on}
        onChange={setOn}
        disabled={!shown.usable}
      />
      <SettingNotes>
        {shown.note && (
          <p role="status" className="text-xs text-on-surface">
            {shown.note}
          </p>
        )}
        <Stack gap="2xs">
          <p className="text-xs text-on-surface-variant">
            Masks profanity in messages and names you see, including P2P chats. Click or tap a
            masked word to show it. Your own messages, names and servers are never masked for you.
            P2P content is never filtered by the instance.
          </p>
          {site && (
            <p className="text-xs text-on-surface-variant">
              <Name of={instanceName(label)} /> also blocks profanity in server content before it is
              posted.
            </p>
          )}
        </Stack>
      </SettingNotes>
    </div>
  )
}

function ConnectionSection() {
  const on = useStore(s => s.iceHelpers)
  const setOn = useStore(s => s.setIceHelpers)
  const relay = useStore(s => s.iceRelay)
  const setRelay = useStore(s => s.setIceRelay)
  const signedIn = useStore(s => s.me !== null)
  const info = useStore(s => s.instance?.ice)
  const own = useStore(s => ownTurn(s.relayPrefs))
  const { label } = useInstanceLabel()
  const named = <Name of={instanceName(label)} />
  const offer = iceOffer(info)
  const relayUsable = (info?.turn === true || own) && on && signedIn
  return (
    <PageRow id="user_connection">
      <p className={sectionCls}>Voice and P2P</p>
      <SettingNotes>
        <p className="text-xs text-on-surface-variant">
          Calls, voice and P2P files connect you straight to the other person, so they can see your
          IP address. Relay only sends everything through the relay instead.
        </p>
      </SettingNotes>
      <SettingSwitch label="Use connection helpers" value={on} onChange={setOn} />
      <SettingNotes gap="2xs">
        <p className="text-xs text-on-surface-variant">
          {offer.length
            ? `Offered here: ${offer.join(', ')}.`
            : 'None: direct connections only, same network.'}
        </p>
        {offer.length > 0 && (
          <p className="text-xs text-on-surface-variant">
            Helpers let calls and P2P files connect across networks. They see your IP address, not
            what you send.
          </p>
        )}
      </SettingNotes>
      <SettingSwitch
        label="Use relay only for P2P (hides your IP)"
        value={relay && relayUsable}
        onChange={setRelay}
        disabled={!relayUsable}
      />
      <SettingNotes>
        <p className="text-xs text-on-surface-variant">
          {relayUsable ? (
            info?.turn === true ? (
              'Others see the relay, not you. Calls may have more delay.'
            ) : (
              <>
                Others see your relay, not you. Voice channels and calls through the server need a
                relay from {named}, so they will not connect.
              </>
            )
          ) : info?.turn !== true && !own ? (
            <>Not available: {named} has no relay. You can add your own TURN relay below.</>
          ) : !signedIn ? (
            'Sign in to use the relay.'
          ) : (
            'Turn on connection helpers to use the relay.'
          )}
        </p>
      </SettingNotes>
    </PageRow>
  )
}

function ProfileSection() {
  const account = useAccount()
  const { label } = useInstanceLabel()
  return (
    <Stack gap="2xl">
      <PageRow id="user_account">
        <Stack gap="2xl">
          <AccountCard />
          <Button
            onClick={() => account.store.getState().openDialog({ kind: 'account_switcher' })}
            place="self-start"
          >
            Switch account
          </Button>
          <ManageAccounts />
        </Stack>
      </PageRow>
      <ProfileFields />
      <PageRow id="user_sign_in">
        <SignInSection />
      </PageRow>
      <PageRow id="user_instance">
        <p className={sectionCls}>
          About <Name of={instanceName(label)} />
        </p>
        <InstanceDetails />
      </PageRow>
    </Stack>
  )
}

function GeneralSection() {
  const relays = useStore(s => s.me !== null)
  const desktop = desktopInfo() !== null && inShell()
  const theme = useStore(s => s.theme)
  const setTheme = useStore(s => s.setTheme)
  const streamer = useStore(s => s.streamer)
  const setStreamer = useStore(s => s.setStreamer)
  return (
    <Stack gap="2xl">
      <StatusSection />
      <ChatSection />
      <ConnectionSection />
      {relays && (
        <PageRow id="user_relays">
          <RelaySection />
        </PageRow>
      )}
      <section>
        <p className={sectionCls}>Appearance</p>
        <PageRow id="user_announcements">
          <AnnouncementSetting />
        </PageRow>
        <PageRow id="user_theme">
          <SettingSwitch
            label="Light theme"
            value={theme === 'light'}
            onChange={v => setTheme(v ? 'light' : 'dark')}
          />
        </PageRow>
        <AnimationsSetting />
      </section>
      <PageRow id="user_streamer">
        <p className={sectionCls}>Streamer mode</p>
        <SettingSwitch label="Streamer mode" value={streamer} onChange={setStreamer} />
        <SettingNotes>
          <p className="text-xs text-on-surface-variant">
            Blurs server names, usernames, and DM names until hovered.
          </p>
        </SettingNotes>
      </PageRow>
      {desktop && (
        <PageRow id="user_desktop" className="empty:hidden">
          <DesktopSection />
        </PageRow>
      )}
    </Stack>
  )
}

function P2pPage() {
  const p2pOn = useP2p(s => s.account !== null)
  return p2pOn ? <P2pSection /> : <P2pOffSection />
}

function Info({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <PageRow id={id}>
      <section>
        <p className={sectionCls}>{title}</p>
        <div className="text-sm text-on-surface-variant">
          <Stack gap="sm">{children}</Stack>
        </div>
      </section>
    </PageRow>
  )
}

function ModerationText() {
  const site = useStore(s => siteFilterOn(s.settings))
  const { label } = useInstanceLabel()
  return (
    <>
      <p>
        {site ? (
          <>
            <Name of={instanceName(label)} /> blocks profanity in server content before it is
            posted: names, channel topics, profile descriptions, file names and channel messages, as
            the admin set it up.
          </>
        ) : (
          <>
            <Name of={instanceName(label)} /> does not filter profanity in server content.
          </>
        )}{' '}
        DMs, passwords and P2P content are never filtered by the instance.
      </p>
      <p>
        Filter profanity in the Chat settings masks profanity in messages and names you see,
        including P2P chats. It only changes what you see, never what is stored or sent.
      </p>
      <p>Rate limits apply per IP across the API.</p>
    </>
  )
}

const WHERE: Record<Shortcut['where'], string> = {
  anywhere: '',
  composer: 'In the message box',
  messages: 'On a message',
  selection: 'While selecting',
}

function ShortcutList() {
  return (
    <Grid as="dl" cols="pair" gap="lg" lineGap="xs">
      {SHORTCUTS.map(sc => (
        <div key={`${sc.keys} ${sc.where}`} className="contents">
          <dt>
            <Surface
              as="kbd"
              pad="xs"
              inset="chip"
              tone="base"
              radius="none"
              text="xs"
              look="rounded-md border border-outline-variant font-mono"
            >
              {shortcutLabel(sc.keys)}
            </Surface>
          </dt>
          <dd>
            {sc.action}
            {WHERE[sc.where] && (
              <span className="text-on-surface-variant/70"> · {WHERE[sc.where]}</span>
            )}
          </dd>
        </div>
      ))}
    </Grid>
  )
}

function InformationSection() {
  const uploadMib = useStore(s => Math.round(limitsOf(s.instance).upload_bytes / 1048576))
  return (
    <Stack gap="2xl">
      <Info id="user_info_about" title="About RChat">
        <p>
          Anonymous chat with a Discord-style layout. Everything runs on the server you connect to;
          no external APIs, no telemetry, no email.
        </p>
      </Info>
      <Info id="user_info_docs" title="Docs">
        <DocsEntry />
      </Info>
      <Info id="user_info_accounts" title="Accounts and passwords">
        <p>
          Accounts are anonymous: no email, no phone, no recovery flow. A lost password means a lost
          account. Passwords are stored as argon2 hashes, never in plain text, and any non-empty
          password is accepted with no strength rules.
        </p>
        <p>
          Word passwords are an alternative: each username maps to a fixed set of 20 words, and the
          secret is your ordered pick of 7. Anyone can see any username&apos;s word set; only the
          ordered selection is private.
        </p>
        <p>
          Login attempts per username are throttled to one every 3 seconds, and over 1000 failures
          in a day lock the account until the next day. Changing your password in settings has its
          own limit for each signed-in session, separate from logins: one try every 3 seconds, and
          50 wrong current passwords in a day pause password changes from that session until the
          next day, while your other sessions can still change it. Login tokens never expire, but
          changing your password signs out every other session, and logging out ends that session.
        </p>
      </Info>
      <Info id="user_info_files" title="Files and attachments">
        <p>
          Server uploads are capped at {uploadMib}MB and deleted exactly one day after posting; the
          message stays and shows a removal notice. Uploaded blobs live in the server database.
        </p>
        <p>
          P2P attachments never touch the server. The file is stored in the sender&apos;s browser
          and transferred directly to viewers, so it is only available while the sender is online
          and still holding it. The sender picks an expiry (or indefinite) when sending.
        </p>
      </Info>
      <Info id="user_info_voice" title="Voice and video">
        <p>
          Voice channels and calls are WebRTC connections directly between browsers. By default
          there is no relay and no external service, so media never passes through the server. If
          the instance offers connection helpers (public STUN servers or its own relay), they help
          peers on different networks find each other, and a relay may forward the encrypted media.
          Turn them off under Voice and P2P to connect only directly.
        </p>
        <p>
          A direct connection shows your IP address to the other person. With relay only on, they
          see the relay instead. Images sent over P2P load when you click them, unless relay only is
          on.
        </p>
        <p>
          You can add your own relays for P2P files and P2P calls. Each side uses its own relays, so
          people with different relays still connect, relay to relay. Before you connect through
          someone else&apos;s relay that you don&apos;t know, you are asked first. Relay only is the
          only real protection, since a peer can always skip relays.
        </p>
      </Info>
      <Info id="user_info_servers" title="Servers and identity">
        <p>
          Lowercased usernames are user IDs, and lowercased server names are server IDs and also the
          invite codes; knowing a server&apos;s name is enough to join or view it. Password
          protected servers require the password first.
        </p>
        <p>
          Guests can open servers by name and receive live updates. Guest chat and guest voice each
          need to be enabled by the site and the server. Guests stay out of the online member list.
          Their server list is saved in their browser.
        </p>
      </Info>
      <Info id="user_info_shortcuts" title="Keyboard shortcuts">
        <p>
          Select text in the message box or the edit box for the formatting toolbar, or use the keys
          below. Spoilers are written as ||text|| and stay hidden until clicked, unless Show
          spoilers is set to Always.
        </p>
        <ShortcutList />
      </Info>
      <Info id="user_info_moderation" title="Moderation">
        <ModerationText />
      </Info>
    </Stack>
  )
}

const SECTION_ICONS: Record<SettingsSection, LucideIcon> = {
  profile: UserRound,
  privacy: ShieldCheck,
  general: SlidersHorizontal,
  notifications: Bell,
  palette: Command,
  sync: RefreshCw,
  p2p: Network,
  information: InfoIcon,
}

function SectionBody({ section }: { section: SettingsSection }) {
  switch (section) {
    case 'profile':
      return <ProfileSection />
    case 'general':
      return <GeneralSection />
    case 'notifications':
      return (
        <PageRow id="user_notifications">
          <NotificationsSection />
        </PageRow>
      )
    case 'privacy':
      return (
        <Stack as="section" gap="lg">
          <PageRow id="user_privacy">
            <PrivacyChoices />
          </PageRow>
          <PageRow id="user_links">
            <LinkSafetySection />
          </PageRow>
          <PageRow id="user_blocked">
            <p className={sectionCls}>Blocked users</p>
            <BlockedUsersSection />
          </PageRow>
          <DeviceKeySection />
        </Stack>
      )
    case 'p2p':
      return (
        <PageRow id="user_p2p">
          <P2pPage />
        </PageRow>
      )
    case 'sync':
      return (
        <PageRow id="user_sync">
          <ConfigSyncSection />
        </PageRow>
      )
    case 'palette':
      return (
        <PageRow id="user_palette">
          <PaletteSettingsSection />
        </PageRow>
      )
    case 'information':
      return <InformationSection />
  }
}

function Menu() {
  const account = useAccount()

  const closeDialog = useStore(s => s.closeDialog)
  const signedIn = useStore(s => s.me !== null && !s.guest)
  const p2pOn = useP2p(s => s.account !== null)
  const kept = useStore(s => !s.settings.p2p && account.identities.offlineData().length > 0)
  const shown = settingsSections({ signedIn, p2p: p2pOn || kept })
  const asked = useStore(s =>
    s.activeDialog?.kind === 'settings' ? (s.activeDialog.section ?? null) : null
  )
  const focus = useStore(s =>
    s.activeDialog?.kind === 'settings' ? (s.activeDialog.focus ?? null) : null
  )
  const pickFor = () => (asked || focus ? sectionFor(asked, focus, shown) : null)
  const [picked, setPicked] = useState<SettingsSection | null>(pickFor)
  const [row, setRow] = useState<string | null>(null)
  const sso = useStore(s => s.activeDialog?.kind === 'settings' && s.activeDialog.sso)
  const askKey = sso || `${asked}|${focus}`
  const [seenAsk, setSeenAsk] = useState(askKey)
  if (seenAsk !== askKey) {
    setSeenAsk(askKey)
    if (asked || focus) {
      setPicked(pickFor())
      setRow(null)
    }
  }
  const section = picked !== null && shown.includes(picked) ? picked : shown[0]
  const desktop = desktopInfo() !== null && inShell()
  const sections: PageSection[] = shown.map(id => ({
    id,
    label: SECTION_LABELS[id],
    icon: SECTION_ICONS[id],
    group: SECTION_GROUPS[id],
    rows: settingsRows(id, { signedIn, desktop }),
    outline: true,
    render: () => <SectionBody section={id} />,
  }))
  const open = (id: string | null, at?: string) => {
    setPicked(id === null ? null : (shown.find(s => s === id) ?? shown[0]))
    setRow(at ?? null)
  }

  return (
    <SettingsPage
      title="Settings"
      closeTitle="Close settings"
      layer="dialog"
      top
      sections={sections}
      active={picked === null ? null : section}
      row={row}
      header={
        <NavAccount section={picked === null ? null : section} onProfile={() => open('profile')} />
      }
      onSection={open}
      onClose={closeDialog}
    />
  )
}
