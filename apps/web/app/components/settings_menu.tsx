'use client'
import { useP2p } from '../lib/client/p2p_react'

import { SignInMethods, useSignInLinks } from './sso/sign_in_methods'
import { useConfirmation } from './sso/use_confirmation'
import { ReAuthPrompt } from './backup_phrase/reauth_prompt'
import { PhraseSettings } from './backup_phrase/phrase_settings'
import { DeleteAccount } from './account_deletion'
import type { LinkedProvider, ReAuthBody } from '../lib/types'
import { Dialog } from './ui'
import { ManageAccounts, SettingsAccountPicker } from './account_switcher'
import { client } from '../lib/client/client'
import { useAccount } from '../lib/client/react'

import { AnnouncementSetting } from './announcements'
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import Link from 'next/link'
import { Globe, UserRound, X } from 'lucide-react'
import { errorText, useStore } from '../lib/store'
import { limitsOf } from '../lib/instance_limits'
import { iceOffer } from '../lib/ice'
import { ownTurn } from '../lib/relays'
import { RelaySection } from './relay_settings'
import { P2pOffSection, P2pSection } from './p2p/p2p_settings'

import {
  SECTION_LABELS,
  sectionFor,
  settingsSections,
  type SettingsSection,
} from '../lib/settings_sections'
import { avatarColorFor, avatarDraft } from '../lib/identicon'
import { defaultBanner } from '../lib/profile'
import { passwordChangeError, secretOf, type PassKind } from '../lib/password'
import { capabilities } from '../lib/platform'
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
import { SettingSwitch } from './settings_fields'
import { MOTION_CHOICES, animHeldBack } from '../lib/motion/setting'
import { useReducedMotion } from '../lib/motion/use_motion'
import { NotificationsSection } from './notify_settings'
import { ConfigSyncSection } from './config_sync'
import { DesktopSection } from './desktop_settings'
import { BlockedUsersSection } from './blocking'
import { PaletteSettingsSection } from './palette_settings'
import { Choice, PrivacyChoices } from './friends'
import { PassSwitch, WordGrid } from './word_grid'
import {
  dangerBtn,
  FieldError,
  fieldCls,
  filledBtn,
  Masked,
  sectionCls,
  textBtn,
  useEscape,
  useOwnServer,
} from './ui'

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
    <div className="flex flex-col gap-2">
      <span className="text-sm text-on-surface-variant">Banner</span>
      <div className="overflow-hidden rounded-2xl bg-surface-container-high" aria-hidden>
        <div style={{ background: shown }} className="h-14" />
        <div className="-mt-8 flex min-w-0 items-end gap-3 px-3 pb-3">
          <span className="shrink-0 rounded-full bg-surface-container-high p-1">
            {avatar ?? (
              <UserAvatar
                username={username}
                avatarKind={kind}
                avatarColor={avatarColor}
                size={56}
              />
            )}
          </span>
          <span className="streamer truncate pb-1 font-medium text-on-surface">{displayName}</span>
        </div>
      </div>
      <ColorField
        label="Banner color"
        value={banner}
        shown={shown}
        onChange={onBanner}
        defaultNote={defaultNote}
        resetLabel={resetLabel}
      />
    </div>
  )
}

function HostedProfileRow({ server }: { server: ServerSummary }) {
  const openDialog = useStore(s => s.openDialog)
  const own = useOwnServer(server.name)
  return (
    <ServerProfileRow
      name={<Masked text={server.display_name} own={own} />}
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
    <div className="mt-6">
      <ServerProfileList more={more ? () => void loadMore() : null}>
        {servers.map(s => (
          <HostedProfileRow key={s.name} server={s} />
        ))}
      </ServerProfileList>
    </div>
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
    <div className="flex flex-col gap-2">
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
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <FieldError id={`${id}-error`} message={error} />
          {done && !error && <p className="pt-1.5 text-xs text-on-surface-variant">Saved</p>}
        </div>
        <span aria-live="polite" className="sr-only">
          {bioAnnouncement(count, done && !error)}
        </span>
        <span
          id={`${id}-count`}
          className={`shrink-0 pt-1.5 text-xs tabular-nums ${over ? 'text-error' : 'text-on-surface-variant'}`}
        >
          {count}/{BIO_MAX}
        </span>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={cancel}
          disabled={text === saved}
          className={`${textBtn} disabled:opacity-40`}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || over || !changed}
          className={filledBtn}
        >
          Save
        </button>
      </div>
    </div>
  )
}

// The top of Profile: who is signed in, and on which instance.
function AccountCard() {
  const me = useStore(s => s.me)
  const { label, host } = useInstanceLabel()
  return (
    <div
      data-account-card
      className="flex min-w-0 flex-col gap-3 rounded-2xl bg-surface-container-high p-4"
    >
      <div className="flex min-w-0 items-center gap-3">
        {me ? (
          <UserAvatar
            username={me.username}
            avatarKind={me.avatar_kind}
            avatarColor={me.avatar_color}
            size={48}
          />
        ) : (
          <GuestAvatar size={48} />
        )}
        <div className="min-w-0">
          <p className="streamer truncate font-medium text-on-surface">
            {me ? me.display_name : 'Guest'}
          </p>
          <p className="streamer truncate text-sm text-on-surface-variant">
            {me ? `@${me.username}` : 'Browsing without an account'}
          </p>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-3 border-t border-outline-variant pt-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-container text-on-primary-container">
          <Globe size={16} />
        </span>
        <div className="min-w-0">
          <p className="streamer truncate text-sm font-medium text-on-surface">{label}</p>
          {host !== label && (
            <p className="streamer truncate text-xs text-on-surface-variant">{host}</p>
          )}
        </div>
      </div>
    </div>
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

// The nav header on wide screens: the account the settings belong to.
function NavAccount() {
  const me = useStore(s => s.me)
  const { label, host } = useInstanceLabel()
  return (
    <div data-nav-account className="hidden min-w-0 items-center gap-3 px-3 pb-3 md:flex">
      {me ? (
        <UserAvatar
          username={me.username}
          avatarKind={me.avatar_kind}
          avatarColor={me.avatar_color}
          size={32}
        />
      ) : (
        <GuestAvatar size={32} />
      )}
      <div className="min-w-0">
        <p className="streamer truncate text-sm font-medium text-on-surface">
          {me ? me.display_name : 'Guest'}
        </p>
        <p className="streamer truncate text-xs text-on-surface-variant">{label}</p>
        {host !== label && (
          <p className="streamer truncate text-xs text-on-surface-variant">{host}</p>
        )}
      </div>
    </div>
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
    <section>
      <p className={sectionCls}>Your profile</p>
      <div className="flex flex-col gap-5">
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
      </div>
      <button
        onClick={() => void patchMe(kind, avatarColorFor(kind, color, background), banner)}
        className={`mt-4 ${filledBtn}`}
      >
        Save profile
      </button>
      <div className="mt-6">
        <AboutMe focus={focusBio} />
      </div>
      <ServerProfiles />
    </section>
  )
}

function SecretField({
  label,
  kind,
  onKind,
  words,
  selected,
  onSelected,
  wordsError,
  onRetry,
  children,
}: {
  label: string
  kind: PassKind
  onKind: (kind: PassKind) => void
  words: string[]
  selected: string[]
  onSelected: (selected: string[]) => void
  wordsError: string | null
  onRetry: () => void
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-on-surface-variant">{label}</span>
      <PassSwitch value={kind} onChange={onKind} label={`${label} type`} />
      {kind === 'text' ? (
        children
      ) : words.length ? (
        <WordGrid words={words} selected={selected} onChange={onSelected} />
      ) : wordsError ? (
        <div className="flex items-center gap-3 text-sm">
          <span className="text-error">Couldn't load your words: {wordsError}</span>
          <button type="button" onClick={onRetry} className="font-medium text-primary">
            Retry
          </button>
        </div>
      ) : (
        <p className="text-sm text-on-surface-variant">Loading your 20 words…</p>
      )}
    </div>
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
  const { api } = useAccount()
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
  const [words, setWords] = useState<string[]>([])
  const [wordsError, setWordsError] = useState<string | null>(null)
  const [wordsTry, setWordsTry] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const needWords = currentKind === 'words' || newKind === 'words'

  useEffect(() => {
    void refreshAccount()
  }, [refreshAccount])

  useEffect(() => {
    if (!needWords || words.length || !username) return
    let live = true
    api
      .words(username)
      .then(res => live && setWords(res.words))
      .catch(e => live && setWordsError(errorText(e)))
    return () => {
      live = false
    }
  }, [needWords, words.length, username, wordsTry])

  if (!username || (first && !allowed)) return null

  const retryWords = () => {
    setWordsError(null)
    setWordsTry(n => n + 1)
  }

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
    <div>
      <p className="mb-3 text-sm font-medium text-on-surface">{title}</p>
      <form onSubmit={submit} className="flex flex-col gap-5">
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
            words={words}
            selected={currentWords}
            onSelected={edit(setCurrentWords)}
            wordsError={wordsError}
            onRetry={retryWords}
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
          words={words}
          selected={newWords}
          onSelected={edit(setNewWords)}
          wordsError={wordsError}
          onRetry={retryWords}
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
        <div>
          <p className="text-xs text-on-surface-variant">
            Other devices and browsers are signed out when you change your password.
          </p>
          <FieldError message={error} />
          {done && (
            <p role="status" className="pt-1.5 text-xs text-primary">
              Password changed
            </p>
          )}
          <button type="submit" disabled={busy} className={`mt-3 ${filledBtn}`}>
            {title}
          </button>
        </div>
      </form>
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
    </div>
  )
}

function AccountMethods() {
  const list = useSignInLinks()
  const phrase = useStore(
    s => s.settings.backup_phrase && s.me?.password_temporary?.change !== 'required'
  )
  return (
    <>
      <PasswordSection links={list.links ?? []} />
      <SignInMethods list={list} />
      {phrase && <PhraseSettings links={list.links ?? []} />}
      <DeleteAccount links={list.links ?? []} />
    </>
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
      <div className="flex flex-col items-start gap-6">
        {signedIn && <AccountMethods key={accountKey} />}
        <Link
          href="/login"
          replace
          data-settings-logout
          onClick={() => {
            closeDialog()
            logout()
          }}
          className={dangerBtn}
        >
          {signedIn ? 'Log out' : 'Exit guest mode'}
        </Link>
      </div>
    </section>
  )
}

function StatusSection() {
  const appearOffline = useStore(s => s.me?.appear_offline)
  const setAppearOffline = useStore(s => s.setAppearOffline)
  if (appearOffline === undefined) return null
  return (
    <section>
      <p className={sectionCls}>Status</p>
      <SettingSwitch
        label="Appear offline"
        value={appearOffline}
        onChange={v => void setAppearOffline(v)}
      />
      <p className="mt-2 px-2 text-xs text-on-surface-variant">
        You will never appear online to others. You can still chat normally.
      </p>
    </section>
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
      <SettingSwitch label="Typing indicators" value={on} onChange={setOn} />
      <p className="mt-2 px-2 text-xs text-on-surface-variant">
        Show when others are typing and let them see when you type. Off hides both.
      </p>
      <ProfanitySwitch />
      <SpoilersChoice />
    </section>
  )
}

function AnimationsSetting() {
  const anim = useStore(s => s.anim)
  const setAnim = useStore(s => s.setAnim)
  const shown = useStore(s => s.me !== null || s.guest)
  const reduced = useReducedMotion(anim.on && anim.motion === 'device')
  if (!shown) return null
  const held = animHeldBack(anim, reduced)
  return (
    <div>
      <SettingSwitch label="Animations" value={anim.on} onChange={on => setAnim({ ...anim, on })} />
      <p className="mt-2 px-2 text-xs text-on-surface-variant">
        Things fade and move when they open, arrive or change.
      </p>
      <div className="mt-4 px-2">
        <Choice
          label="Motion"
          value={anim.motion}
          options={MOTION_CHOICES}
          onChange={motion => setAnim({ ...anim, motion })}
        />
        {held && (
          <p role="status" className="mt-2 text-xs text-on-surface">
            {held}
          </p>
        )}
      </div>
    </div>
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
    <div className="mt-4 px-2">
      <Choice label="Show spoilers" value={show} options={SPOILER_CHOICES} onChange={setShow} />
      <p className="mt-2 text-xs text-on-surface-variant">
        Always shows spoiler text and attachments without a click, except in streamer mode. Previews
        and notifications keep them hidden.
      </p>
    </div>
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
    <div className="mt-4">
      <SettingSwitch
        label="Filter profanity"
        value={shown.on}
        onChange={setOn}
        disabled={!shown.usable}
      />
      {shown.note && (
        <p role="status" className="mt-2 px-2 text-xs text-on-surface">
          {shown.note}
        </p>
      )}
      <p className="mt-2 px-2 text-xs text-on-surface-variant">
        Masks profanity in messages and names you see, including P2P chats. Click or tap a masked
        word to show it. Your own messages, names and servers are never masked for you. P2P content
        is never filtered by the instance.
      </p>
      {site && (
        <p className="mt-1 px-2 text-xs text-on-surface-variant">
          <span className="streamer">{label}</span> also blocks profanity in server content before
          it is posted.
        </p>
      )}
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
  const named = <span className="streamer">{label}</span>
  const offer = iceOffer(info)
  const relayUsable = (info?.turn === true || own) && on && signedIn
  return (
    <section>
      <p className={sectionCls}>Voice and P2P</p>
      <p className="mb-2 px-2 text-xs text-on-surface-variant">
        Calls, voice and P2P files connect you straight to the other person, so they can see your IP
        address. Relay only sends everything through the relay instead.
      </p>
      <SettingSwitch label="Use connection helpers" value={on} onChange={setOn} />
      <p className="mt-2 px-2 text-xs text-on-surface-variant">
        {offer.length
          ? `Offered here: ${offer.join(', ')}.`
          : 'None: direct connections only, same network.'}
      </p>
      {offer.length > 0 && (
        <p className="mt-1 px-2 text-xs text-on-surface-variant">
          Helpers let calls and P2P files connect across networks. They see your IP address, not
          what you send.
        </p>
      )}
      <div className="mt-2">
        <SettingSwitch
          label="Use relay only for P2P (hides your IP)"
          value={relay && relayUsable}
          onChange={setRelay}
          disabled={!relayUsable}
        />
      </div>
      <p className="mt-2 px-2 text-xs text-on-surface-variant">
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
    </section>
  )
}

function ProfileSection() {
  const account = useAccount()
  const { label } = useInstanceLabel()
  return (
    <div className="flex flex-col gap-8">
      <AccountCard />
      <button
        className="self-start text-sm text-primary"
        onClick={() => account.store.getState().openDialog({ kind: 'account_switcher' })}
      >
        Switch account
      </button>
      <ManageAccounts />
      <ProfileFields />
      <SignInSection />
      <section>
        <p className={sectionCls}>
          About <span className="streamer">{label}</span>
        </p>
        <InstanceDetails />
      </section>
    </div>
  )
}

function GeneralSection() {
  const theme = useStore(s => s.theme)
  const setTheme = useStore(s => s.setTheme)
  const streamer = useStore(s => s.streamer)
  const setStreamer = useStore(s => s.setStreamer)
  return (
    <div className="flex flex-col gap-8">
      <StatusSection />
      <ChatSection />
      <ConnectionSection />
      <RelaySection />
      <section>
        <p className={sectionCls}>Appearance</p>
        <AnnouncementSetting />
        <SettingSwitch
          label="Light theme"
          value={theme === 'light'}
          onChange={v => setTheme(v ? 'light' : 'dark')}
        />
        <AnimationsSetting />
      </section>
      <section>
        <p className={sectionCls}>Streamer mode</p>
        <SettingSwitch label="Streamer mode" value={streamer} onChange={setStreamer} />
        <p className="mt-2 px-2 text-xs text-on-surface-variant">
          Blurs server names, usernames, and DM names until hovered.
        </p>
      </section>
      <DesktopSection />
    </div>
  )
}

function P2pPage() {
  const p2pOn = useP2p(s => s.account !== null)
  return p2pOn ? <P2pSection /> : <P2pOffSection />
}

function Info({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className={sectionCls}>{title}</p>
      <div className="flex flex-col gap-2 text-sm text-on-surface-variant">{children}</div>
    </section>
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
            <span className="streamer">{label}</span> blocks profanity in server content before it
            is posted: names, channel topics, profile descriptions, file names and channel messages,
            as the admin set it up.
          </>
        ) : (
          <>
            <span className="streamer">{label}</span> does not filter profanity in server content.
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
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
      {SHORTCUTS.map(sc => (
        <div key={`${sc.keys} ${sc.where}`} className="contents">
          <dt>
            <kbd className="rounded-md border border-outline-variant bg-surface-container px-1.5 py-0.5 font-mono text-xs text-on-surface">
              {shortcutLabel(sc.keys)}
            </kbd>
          </dt>
          <dd>
            {sc.action}
            {WHERE[sc.where] && (
              <span className="text-on-surface-variant/70"> · {WHERE[sc.where]}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function InformationSection() {
  const uploadMib = useStore(s => Math.round(limitsOf(s.instance).upload_bytes / 1048576))
  return (
    <div className="flex flex-col gap-8">
      <Info title="About RChat">
        <p>
          Anonymous chat with a Discord-style layout. Everything runs on the server you connect to;
          no external APIs, no telemetry, no email.
        </p>
      </Info>
      <Info title="Accounts and passwords">
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
      <Info title="Files and attachments">
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
      <Info title="Voice and video">
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
      <Info title="Servers and identity">
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
      <Info title="Keyboard shortcuts">
        <p>
          Select text in the message box or the edit box for the formatting toolbar, or use the keys
          below. Spoilers are written as ||text|| and stay hidden until clicked, unless Show
          spoilers is set to Always.
        </p>
        <ShortcutList />
      </Info>
      <Info title="Moderation">
        <ModerationText />
      </Info>
    </div>
  )
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
  const [picked, setPicked] = useState<SettingsSection>(() => sectionFor(asked, focus, shown))
  const sso = useStore(s => s.activeDialog?.kind === 'settings' && s.activeDialog.sso)
  const askKey = sso || `${asked}|${focus}`
  const [seenAsk, setSeenAsk] = useState(askKey)
  if (seenAsk !== askKey) {
    setSeenAsk(askKey)
    if (asked || focus) setPicked(sectionFor(asked, focus, shown))
  }
  const section = shown.includes(picked) ? picked : shown[0]
  useEscape(closeDialog)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="fixed inset-x-0 top-app z-50 flex h-app flex-col bg-surface px-safe md:flex-row"
    >
      <div className="flex shrink-0 items-center border-b border-outline-variant bg-surface-container-low pr-3 md:contents">
        <nav
          aria-label="Settings sections"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto p-3 md:w-56 md:flex-none md:flex-col md:overflow-y-auto md:border-r md:border-outline-variant md:bg-surface-container-low md:p-4"
        >
          <NavAccount />
          <SettingsAccountPicker section={section} />
          {shown.map(key => (
            <button
              key={key}
              data-settings-section={key}
              aria-current={section === key ? 'page' : undefined}
              onClick={() => setPicked(key)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-left text-sm md:rounded-xl md:py-2 ${
                section === key
                  ? 'bg-secondary-container text-on-secondary-container'
                  : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
              }`}
            >
              {SECTION_LABELS[key]}
            </button>
          ))}
        </nav>
        <button
          title="Close settings"
          aria-label="Close settings"
          onClick={closeDialog}
          className="shrink-0 rounded-full md:absolute md:top-4 md:right-[max(1rem,env(safe-area-inset-right))] md:z-10 border border-outline-variant bg-surface p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
        >
          <X size={18} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-6 md:p-10">
        <div className="max-w-lg pb-10">
          {section === 'profile' ? (
            <ProfileSection />
          ) : section === 'general' ? (
            <GeneralSection />
          ) : section === 'notifications' ? (
            <NotificationsSection />
          ) : section === 'privacy' ? (
            <section>
              <p className={sectionCls}>Privacy</p>
              <PrivacyChoices />
              <p className={sectionCls}>Blocked users</p>
              <BlockedUsersSection />
            </section>
          ) : section === 'p2p' ? (
            <P2pPage />
          ) : section === 'sync' ? (
            <ConfigSyncSection />
          ) : section === 'palette' ? (
            <PaletteSettingsSection />
          ) : (
            <InformationSection />
          )}
        </div>
      </div>
    </div>
  )
}
