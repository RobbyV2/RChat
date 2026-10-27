'use client'

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { api } from '../lib/instances'
import { errorText, useStore } from '../lib/store'
import { defaultBanner } from '../lib/profile'
import { passwordChangeError, secretOf, type PassKind } from '../lib/password'
import { BIO_MAX, bioAnnouncement, bioError, charCount, cleanBio } from '../lib/rules'
import type { AvatarKind } from '../lib/types'
import { AvatarPicker } from './avatar_picker'
import { InstanceDetails } from './instance_badge'
import { UserAvatar } from './user_avatar'
import { SettingSwitch } from './admin_panel'
import { PassSwitch, WordGrid } from './word_grid'
import { FieldError, fieldCls, filledBtn, sectionCls, textBtn, useEscape } from './server_settings'

const bioFieldCls = fieldCls.replace(' border-outline', '').replace(' focus:border-primary', '')

type Section = 'settings' | 'information'

export default function SettingsMenu() {
  const open = useStore(s => s.activeDialog?.kind === 'settings')
  return open ? <Menu /> : null
}

function BannerPicker({
  username,
  displayName,
  kind,
  avatarColor,
  banner,
  onBanner,
}: {
  username: string
  displayName: string
  kind: AvatarKind
  avatarColor: string
  banner: string | null
  onBanner: (color: string | null) => void
}) {
  const shown = banner ?? defaultBanner({ username, avatar_kind: kind, avatar_color: avatarColor })
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-on-surface-variant">Banner</span>
      <div className="overflow-hidden rounded-2xl bg-surface-container-high" aria-hidden>
        <div style={{ background: shown }} className="h-14" />
        <div className="-mt-8 flex min-w-0 items-end gap-3 px-3 pb-3">
          <span className="shrink-0 rounded-full bg-surface-container-high p-1">
            <UserAvatar username={username} avatarKind={kind} avatarColor={avatarColor} size={56} />
          </span>
          <span className="streamer truncate pb-1 font-medium text-on-surface">{displayName}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-on-surface-variant">
        <label className="flex items-center gap-3">
          Banner color
          <input
            type="color"
            value={shown}
            onChange={e => onBanner(e.target.value)}
            className="h-8 w-12 cursor-pointer rounded bg-transparent"
          />
        </label>
        {banner === null ? (
          <span className="text-xs">Default, follows your avatar</span>
        ) : (
          <button type="button" onClick={() => onBanner(null)} className={textBtn}>
            Use default
          </button>
        )}
      </div>
    </div>
  )
}

function AboutMe({ focus }: { focus: boolean }) {
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
    setText(useStore.getState().me?.bio ?? '')
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
      <div className="flex items-start justify-between gap-3">
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

function AccountSection() {
  const focusBio = useStore(
    s => s.activeDialog?.kind === 'settings' && s.activeDialog.focus === 'bio'
  )
  const me = useStore(s => s.me)
  const patchMe = useStore(s => s.patchMe)
  const [kind, setKind] = useState<AvatarKind>(me?.avatar_kind ?? 'identicon')
  const [color, setColor] = useState(me?.avatar_color ?? '#6750a4')
  const [banner, setBanner] = useState<string | null>(me?.banner_color ?? null)
  if (!me) return null
  return (
    <section>
      <p className={sectionCls}>Account</p>
      <p className="mb-4 text-sm text-on-surface-variant">
        Signed in as <span className="streamer font-medium text-on-surface">{me.display_name}</span>
      </p>
      <div className="flex flex-col gap-5">
        <AvatarPicker
          username={me.username}
          kind={kind}
          color={color}
          onKind={setKind}
          onColor={setColor}
        />
        <BannerPicker
          username={me.username}
          displayName={me.display_name}
          kind={kind}
          avatarColor={color}
          banner={banner}
          onBanner={setBanner}
        />
      </div>
      <button
        onClick={() => void patchMe(kind, kind === 'color' ? color : undefined, banner)}
        className={`mt-4 ${filledBtn}`}
      >
        Save profile
      </button>
      <div className="mt-6">
        <AboutMe focus={focusBio} />
      </div>
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

function PasswordSection() {
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

  if (!username) return null

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
    const invalid = passwordChangeError({
      currentKind,
      current,
      currentWords,
      newKind,
      next,
      confirm,
      newWords,
    })
    if (invalid) {
      setError(invalid)
      return
    }
    setBusy(true)
    const err = await changePassword(
      secretOf(currentKind, current, currentWords),
      secretOf(newKind, next, newWords),
      newKind
    )
    setBusy(false)
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
    <section>
      <p className={sectionCls}>Change password</p>
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
            Change password
          </button>
        </div>
      </form>
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

function SettingsSection() {
  const theme = useStore(s => s.theme)
  const setTheme = useStore(s => s.setTheme)
  const streamer = useStore(s => s.streamer)
  const setStreamer = useStore(s => s.setStreamer)
  return (
    <div className="flex flex-col gap-8">
      <section>
        <p className={sectionCls}>Instance</p>
        <InstanceDetails />
      </section>
      <AccountSection />
      <PasswordSection />
      <StatusSection />
      <section>
        <p className={sectionCls}>Appearance</p>
        <SettingSwitch
          label="Light theme"
          value={theme === 'light'}
          onChange={v => setTheme(v ? 'light' : 'dark')}
        />
      </section>
      <section>
        <p className={sectionCls}>Streamer mode</p>
        <SettingSwitch label="Streamer mode" value={streamer} onChange={setStreamer} />
        <p className="mt-2 px-2 text-xs text-on-surface-variant">
          Blurs server names, usernames, and DM names until hovered.
        </p>
      </section>
    </div>
  )
}

function Info({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className={sectionCls}>{title}</p>
      <div className="flex flex-col gap-2 text-sm text-on-surface-variant">{children}</div>
    </section>
  )
}

function InformationSection() {
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
          Server uploads are capped at 25MB and deleted exactly one day after posting; the message
          stays and shows a removal notice. Uploaded blobs live in the server database.
        </p>
        <p>
          P2P attachments never touch the server. The file is stored in the sender&apos;s browser
          and transferred directly to viewers, so it is only available while the sender is online
          and still holding it. The sender picks an expiry (or indefinite) when sending.
        </p>
      </Info>
      <Info title="Voice and video">
        <p>
          Voice channels and calls are WebRTC connections directly between browsers, with no relay
          or external services; media never passes through the server. P2P calls likewise connect
          peer to peer.
        </p>
      </Info>
      <Info title="Servers and identity">
        <p>
          Lowercased usernames are user IDs, and lowercased server names are server IDs and also the
          invite codes; knowing a server&apos;s name is enough to join or view it. Password
          protected servers require the password first.
        </p>
        <p>
          Guests browse read-only with no account: they can view servers by name, receive live
          updates, and never appear in presence. Their server list lives in their own browser.
        </p>
      </Info>
      <Info title="Moderation">
        <p>
          Profanity filtering runs server-side on usernames, server names, channel names, profile
          descriptions and channel messages; DMs and passwords are exempt. Rate limits apply per IP
          across the API.
        </p>
      </Info>
    </div>
  )
}

function Menu() {
  const closeDialog = useStore(s => s.closeDialog)
  const [section, setSection] = useState<Section>('settings')
  const titleId = useId()
  useEscape(closeDialog)

  const sections: [Section, string][] = [
    ['settings', 'Settings'],
    ['information', 'Information'],
  ]

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-x-0 top-0 z-50 flex h-app flex-col bg-surface px-safe md:flex-row"
    >
      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-outline-variant bg-surface-container-low p-3 pr-16 md:w-56 md:flex-col md:overflow-y-auto md:border-r md:border-b-0 md:p-4">
        <p
          id={titleId}
          className="hidden px-3 pb-2 text-xs font-medium tracking-wide text-on-surface-variant uppercase md:block"
        >
          Settings
        </p>
        {sections.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSection(key)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-left text-sm md:rounded-xl md:py-2 ${
              section === key
                ? 'bg-secondary-container text-on-secondary-container'
                : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
      <button
        title="Close settings"
        onClick={closeDialog}
        className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(1rem,env(safe-area-inset-right))] z-10 rounded-full border border-outline-variant bg-surface p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface md:top-4"
      >
        <X size={18} />
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto p-6 md:p-10">
        <div className="max-w-lg pb-10">
          {section === 'settings' ? <SettingsSection /> : <InformationSection />}
        </div>
      </div>
    </div>
  )
}
