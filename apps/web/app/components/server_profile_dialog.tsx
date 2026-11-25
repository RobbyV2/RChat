'use client'

import { useEffect, useId, useState, type ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { useApi } from '../lib/client/react'
import { DEFAULT_COLOR } from '../lib/identicon'
import { MODE_LABELS, PROFILE_FIELDS } from '../lib/profile_fields'
import {
  LOCK_CHOICES,
  RESET_FIELDS,
  RESET_LABELS,
  lockLine,
  lockState,
  type LockSecs,
  type LockState,
  type ResetField,
} from '../lib/profile_reset'
import { REASON_MAX } from '../lib/timeouts'
import { charsLeft } from '../lib/rules'
import { shownBanner, shownBio, shownUser } from '../lib/server_profile'
import {
  bioLeft,
  draftError,
  draftFor,
  draftOfProfile,
  emptyDraft,
  patchOf,
  previewUser,
  sameDraft,
  type ProfileDraft,
} from '../lib/server_profile_editor'
import { errorText, useStore } from '../lib/store'
import type { AvatarKind, MemberLook, ProfilesMode, ServerProfile, UserRef } from '../lib/types'
import { AvatarPicker } from './avatar_picker'
import { NameWithUsername } from './display_name'
import { BannerPicker } from './settings_menu'
import { useLook } from './shown_user'
import { useNow } from './timeout_dialog'
import {
  Dialog,
  FieldError,
  Masked,
  dangerBtn,
  fieldCls,
  filledBtn,
  filledDangerBtn,
  textBtn,
} from './ui'
import { UserAvatar } from './user_avatar'

const labelCls = 'text-sm text-on-surface-variant'
const boxCls = fieldCls.replace(' border-outline', '').replace(' focus:border-primary', '')

const when = (until: number) =>
  new Date(until * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

// Where the editor reads and writes a server profile: a hosted server through its routes, or a
// P2P server through the profile this device signs into it.
export interface ProfileEditorSource {
  // Who you are there without a server profile.
  account: UserRef
  accountBio: string | null
  accountBanner: string | null
  // What the profile falls back to, in the words of the place ("account", "P2P profile").
  origin: string
  mode: ProfilesMode
  // Whether members may set a name there: the place's mode and, on a hosted server, the site's
  // display names switch.
  names: boolean
  // The stored profile; null while it loads.
  saved: ProfileDraft | null
  failed?: boolean
  lock: LockState
  // Draws someone's picture there.
  avatar: (user: UserRef, size: number) => ReactNode
  // Whether a name shows with the username after it.
  handles: boolean
  save: (from: ProfileDraft, to: ProfileDraft) => Promise<string | null>
  clear: () => Promise<string | null>
}

const sameStored = (a: ProfileDraft | null, b: ProfileDraft | null) =>
  a === null || b === null ? a === b : sameDraft(a, b)

function Preview({ source, draft }: { source: ProfileEditorSource; draft: ProfileDraft }) {
  const user = previewUser(source.account, draft, source.mode, source.names)
  const bio = shownBio(user, { bio: source.accountBio, server_bio: draft.bio.trim() || null })
  const banner = shownBanner(user, {
    banner_color: source.accountBanner,
    server_banner: draft.banner,
  })
  const name = source.handles ? (
    <NameWithUsername user={user} own />
  ) : (
    <Masked text={user.display_name} own />
  )
  return (
    <div
      data-profile-preview
      aria-label="Preview"
      role="group"
      className="grid gap-3 sm:grid-cols-2"
    >
      <div className="flex min-w-0 gap-3 rounded-2xl bg-surface p-3">
        <span className="shrink-0 pt-0.5">{source.avatar(user, 36)}</span>
        <div className="min-w-0">
          <p className="streamer truncate text-sm font-medium text-on-surface">{name}</p>
          <p className="text-sm text-on-surface-variant">How you look in messages here</p>
        </div>
      </div>
      <div className="min-w-0 overflow-hidden rounded-2xl bg-surface">
        <div aria-hidden style={{ background: banner }} className="h-10" />
        <div className="-mt-5 flex min-w-0 items-end gap-2 px-3">
          <span className="shrink-0 rounded-full bg-surface p-1">{source.avatar(user, 40)}</span>
          <span className="streamer truncate pb-1 text-sm font-semibold text-on-surface">
            <Masked text={user.display_name} own />
          </span>
        </div>
        <p className="streamer line-clamp-3 min-h-5 px-3 pt-1 pb-3 text-xs break-words whitespace-pre-wrap text-on-surface-variant">
          {bio ? <Masked text={bio} own /> : null}
        </p>
      </div>
    </div>
  )
}

// The editor of your own profile in one server. Each part is optional; a part left alone shows
// what your account (or P2P profile) has.
export function ProfileEditor({
  source,
  onClose,
}: {
  source: ProfileEditorSource
  onClose: () => void
}) {
  const { saved, account, origin } = source
  const [draft, setDraft] = useState<ProfileDraft | null>(saved)
  const [seen, setSeen] = useState(saved)
  if (!sameStored(seen, saved)) {
    // The stored profile arrived or changed under the dialog (a reset, another device).
    const untouched = draft === null || seen === null || sameDraft(draft, seen)
    setSeen(saved)
    if (untouched) setDraft(saved)
  }
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameId = useId()
  const bioId = useId()
  const locked = source.lock.locked
  const line = lockLine(source.lock, when)
  if (source.failed)
    return (
      <Dialog title="Server profile" onClose={onClose} full>
        <p className="text-sm text-on-surface-variant">Couldn&apos;t load your server profile.</p>
      </Dialog>
    )
  if (source.mode === 'off')
    return (
      <Dialog title="Server profile" onClose={onClose} full>
        <p data-profile-off className="text-sm text-on-surface-variant">
          Server profiles are off in this server.
        </p>
      </Dialog>
    )
  if (!saved || !draft)
    return (
      <Dialog title="Server profile" onClose={onClose} full>
        <p className="text-sm text-on-surface-variant">Loading…</p>
      </Dialog>
    )
  // Under a mode without names the stored name is left as it is: it is neither shown nor sent.
  const base = draftFor(saved, source.names)
  const shown = draftFor(draft, source.names)
  const change = (patch: Partial<ProfileDraft>) => {
    setDraft({ ...draft, ...patch })
    setError(null)
  }
  const invalid = draftError(shown)
  const changed = !sameDraft(shown, base)
  const left = bioLeft(draft)
  const kind: AvatarKind = draft.avatar?.kind ?? account.avatar_kind
  const color =
    draft.avatar?.kind === 'color' ? (draft.avatar.color ?? DEFAULT_COLOR) : DEFAULT_COLOR
  const background = draft.avatar?.kind === 'identicon' ? draft.avatar.color : null
  const picture = previewUser(account, shown, source.mode, source.names)
  const finish = async (run: () => Promise<string | null>) => {
    if (busy) return
    setBusy(true)
    const err = await run()
    setBusy(false)
    if (err) setError(err)
    else onClose()
  }
  const submit = () => {
    if (invalid) return setError(invalid)
    void finish(() => source.save(base, shown))
  }
  return (
    <Dialog title="Server profile" onClose={onClose} full>
      <form
        data-server-profile
        onSubmit={e => {
          e.preventDefault()
          submit()
        }}
        className="flex flex-col gap-5"
      >
        {line && (
          <p
            data-profile-locked
            role="status"
            className="flex items-start gap-2 rounded-xl bg-error-container px-3 py-2 text-sm text-on-error-container"
          >
            <Lock size={16} className="mt-0.5 shrink-0" aria-hidden />
            {line}
          </p>
        )}
        <Preview source={source} draft={shown} />
        <fieldset disabled={locked || busy} className="flex min-w-0 flex-col gap-5">
          {source.names ? (
            <div className="flex flex-col gap-2">
              <label htmlFor={nameId} className={labelCls}>
                Server name
              </label>
              <div className="flex gap-2">
                <input
                  id={nameId}
                  value={draft.name}
                  maxLength={PROFILE_FIELDS.name.max * 2}
                  onChange={e => change({ name: e.target.value })}
                  placeholder={account.display_name}
                  autoComplete="off"
                  className={`${boxCls} streamer min-w-0 flex-1 border-outline focus:border-primary`}
                />
                {draft.name !== '' && (
                  <button type="button" onClick={() => change({ name: '' })} className={textBtn}>
                    Use {origin} name
                  </button>
                )}
              </div>
              <p className="text-xs text-on-surface-variant">
                Only this server shows it. Leave it empty to use your {origin} name.
              </p>
            </div>
          ) : (
            <p data-profile-no-names className="text-sm text-on-surface-variant">
              {source.mode === 'no_names'
                ? "This server doesn't use server names."
                : 'Names are off on this site.'}
            </p>
          )}
          <div className="flex flex-col gap-2">
            {draft.avatar === null ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className={labelCls}>Avatar</span>
                {source.avatar(account, 32)}
                <span className="text-xs text-on-surface-variant">As on your {origin}</span>
                <button
                  type="button"
                  onClick={() =>
                    change({
                      avatar: {
                        kind: account.avatar_kind,
                        color: account.avatar_color ?? (kind === 'color' ? DEFAULT_COLOR : null),
                      },
                    })
                  }
                  className={textBtn}
                >
                  Change for this server
                </button>
              </div>
            ) : (
              <>
                <AvatarPicker
                  username={account.username}
                  kind={kind}
                  color={color}
                  onKind={next =>
                    change({
                      avatar: { kind: next, color: next === 'color' ? color : background },
                    })
                  }
                  onColor={next => change({ avatar: { kind: 'color', color: next } })}
                  background={background}
                  onBackground={next => change({ avatar: { kind: 'identicon', color: next } })}
                  avatar={(k, c) =>
                    source.avatar({ ...account, avatar_kind: k, avatar_color: c }, 48)
                  }
                  disabled={locked || busy}
                />
                <button
                  type="button"
                  onClick={() => change({ avatar: null })}
                  className={`${textBtn} self-start`}
                >
                  Use {origin} avatar
                </button>
              </>
            )}
          </div>
          <BannerPicker
            username={account.username}
            displayName={picture.display_name}
            kind={picture.avatar_kind}
            avatarColor={picture.avatar_color}
            banner={draft.banner}
            onBanner={banner => change({ banner })}
            fallback={source.accountBanner}
            avatar={source.avatar(picture, 56)}
            defaultNote={`As on your ${origin}`}
            resetLabel={`Use ${origin} banner`}
          />
          <div className="flex flex-col gap-2">
            <label htmlFor={bioId} className={labelCls}>
              Description
            </label>
            <textarea
              id={bioId}
              rows={3}
              value={draft.bio}
              onChange={e => change({ bio: e.target.value })}
              placeholder={source.accountBio ?? 'Tell this server a little about yourself'}
              aria-invalid={left < 0}
              aria-describedby={`${bioId}-count`}
              className={`${boxCls} streamer resize-none ${
                left < 0 ? 'border-error' : 'border-outline focus:border-primary'
              }`}
            />
            <div className="flex items-center justify-between gap-3">
              {draft.bio !== '' ? (
                <button type="button" onClick={() => change({ bio: '' })} className={textBtn}>
                  Use {origin} description
                </button>
              ) : (
                <span />
              )}
              <span
                id={`${bioId}-count`}
                className={`text-xs tabular-nums ${left < 0 ? 'text-error' : 'text-on-surface-variant'}`}
              >
                <span className="sr-only" aria-live="polite">
                  {charsLeft(left, 20)}
                </span>
                <span aria-hidden>{left}</span>
              </span>
            </div>
          </div>
        </fieldset>
        <FieldError message={error ?? (changed ? invalid : null)} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            disabled={locked || busy || emptyDraft(saved)}
            onClick={() => void finish(source.clear)}
            className={dangerBtn}
          >
            Reset all
          </button>
          <span className="flex gap-2">
            <button type="button" onClick={onClose} className={textBtn}>
              {locked ? 'Close' : 'Cancel'}
            </button>
            {!locked && (
              <button
                type="submit"
                disabled={busy || !changed || invalid !== null}
                className={filledBtn}
              >
                Save
              </button>
            )}
          </span>
        </div>
      </form>
    </Dialog>
  )
}

export const accountAvatar = (user: UserRef, size: number) => (
  <UserAvatar
    username={user.username}
    avatarKind={user.avatar_kind}
    avatarColor={user.avatar_color}
    size={size}
  />
)

function HostedProfileDialog({ server }: { server: string }) {
  const close = useStore(s => s.closeDialog)
  const me = useStore(s => s.me)
  const stored = useStore(s => s.servers[server]?.my_profile)
  const displayNames = useStore(s => s.settings.display_names !== false)
  const load = useStore(s => s.loadMyProfile)
  const save = useStore(s => s.saveMyProfile)
  const clear = useStore(s => s.clearMyProfile)
  // Read again when the dialog opens: a lock or a reset may be newer than what the page holds,
  // and a server that isn't open here holds nothing.
  const [loaded, setLoaded] = useState<ServerProfile | null>(null)
  const [asked, setAsked] = useState(false)
  useEffect(() => {
    let live = true
    void load(server).then(p => {
      if (!live) return
      setLoaded(p)
      setAsked(true)
    })
    return () => {
      live = false
    }
  }, [load, server])
  const mine = stored ?? loaded
  const now = useNow(typeof mine?.locked_until === 'number', 30_000)
  if (!me) return null
  return (
    <ProfileEditor
      onClose={close}
      source={{
        account: me,
        accountBio: me.bio,
        accountBanner: me.banner_color,
        origin: 'account',
        mode: mine?.mode ?? 'all',
        names: mine?.mode === 'all' && displayNames,
        saved: mine ? draftOfProfile(mine) : null,
        failed: asked && !mine,
        lock: lockState(mine?.locked_until, Math.floor(now / 1000)),
        avatar: accountAvatar,
        handles: true,
        save: async (from, to) => {
          const err = await save(server, patchOf(from, to))
          if (err) setLoaded(await load(server))
          return err
        },
        clear: () => clear(server),
      }}
    />
  )
}

// Where the reset dialog reads a member's server profile and sends the reset.
export interface ProfileResetSource {
  // The member as the server shows them now, and the line under that name: their @username on
  // a hosted server, the name a P2P member gives themselves (null: none).
  user: UserRef
  subtitle: string | null
  // The server name a reset of the name removes; null when they have none.
  name: string | null
  lock: LockState
  // Whether the reset keeps a reason (a hosted server's audit log does).
  reasons: boolean
  avatar: (user: UserRef, size: number) => ReactNode
  submit: (fields: ResetField[], secs: LockSecs, reason: string) => Promise<string | null>
  unlock: () => Promise<unknown>
}

const chip = (on: boolean) =>
  `rounded-full border px-3 py-1.5 text-sm ${
    on
      ? 'border-primary bg-primary-container text-on-primary-container'
      : 'border-outline text-on-surface hover:bg-surface-container-highest'
  }`

// A moderator clears parts of someone's server profile and may lock it for a while.
export function ProfileReset({
  source,
  onClose,
}: {
  source: ProfileResetSource
  onClose: () => void
}) {
  const { user, lock } = source
  const [fields, setFields] = useState<ResetField[]>(['name'])
  const [secs, setSecs] = useState<LockSecs>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ready = fields.length > 0 || secs !== null
  const submit = async () => {
    if (busy || !ready) return
    setBusy(true)
    const err = await source.submit(fields, secs, reason)
    setBusy(false)
    if (err) setError(err)
    else onClose()
  }
  const toggle = (f: ResetField) =>
    setFields(cur => (cur.includes(f) ? cur.filter(x => x !== f) : [...cur, f]))
  return (
    <Dialog title="Reset server profile" onClose={onClose}>
      <div data-profile-reset className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          {source.avatar(user, 36)}
          <div className="min-w-0">
            <p className="streamer truncate text-sm font-medium text-on-surface">
              <Masked text={user.display_name} />
            </p>
            {source.subtitle !== null && (
              <p
                data-profile-reset-who
                className="streamer truncate text-xs text-on-surface-variant"
              >
                <Masked text={source.subtitle} />
              </p>
            )}
          </div>
        </div>
        <p className="text-sm text-on-surface-variant">
          What you reset goes back to what their profile has outside this server.
        </p>
        {lock.locked && (
          <div
            data-profile-reset-locked
            className="flex flex-wrap items-center gap-2 rounded-xl bg-error-container px-3 py-2 text-sm text-on-error-container"
          >
            <Lock size={16} className="shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              {lock.until === null ? 'Locked until unlocked' : `Locked until ${when(lock.until)}`}
            </span>
            <button
              onClick={() => {
                void source.unlock()
                onClose()
              }}
              className={dangerBtn}
            >
              Unlock
            </button>
          </div>
        )}
        <fieldset className="flex flex-col gap-1">
          <legend className="pb-1 text-xs font-medium tracking-wide text-on-surface-variant uppercase">
            Reset
          </legend>
          {RESET_FIELDS.map(f => (
            <label key={f} className="flex min-h-9 items-center gap-3 text-sm text-on-surface">
              <input
                type="checkbox"
                checked={fields.includes(f)}
                onChange={() => toggle(f)}
                className="size-4 accent-primary"
              />
              <span className="min-w-0">
                {RESET_LABELS[f]}
                {f === 'name' && source.name !== null && (
                  <span className="streamer text-on-surface-variant">
                    {' '}
                    (<Masked text={source.name} />)
                  </span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
        <div>
          <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
            Lock their server profile
          </p>
          <div role="radiogroup" aria-label="Lock" className="mt-2 flex flex-wrap gap-2">
            {LOCK_CHOICES.map(c => (
              <button
                key={String(c.secs)}
                role="radio"
                aria-checked={secs === c.secs}
                onClick={() => setSecs(c.secs)}
                className={chip(secs === c.secs)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <p className="pt-1.5 text-xs text-on-surface-variant">
            While it is locked they can&apos;t change their server profile.
          </p>
        </div>
        {source.reasons && (
          <label className="block text-xs font-medium tracking-wide text-on-surface-variant uppercase">
            Reason
            <input
              value={reason}
              maxLength={REASON_MAX}
              onChange={e => setReason(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void submit()
              }}
              placeholder="Optional, shown to moderators"
              className={`${fieldCls} mt-1.5 w-full tracking-normal text-on-surface normal-case`}
            />
          </label>
        )}
        <FieldError message={error} />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className={textBtn}>
            Cancel
          </button>
          <button
            disabled={!ready || busy}
            onClick={() => void submit()}
            className={`${filledDangerBtn} disabled:opacity-40`}
          >
            {fields.length ? 'Reset' : 'Lock'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

function HostedResetDialog({ server, user }: { server: string; user: UserRef }) {
  const api = useApi()
  const close = useStore(s => s.closeDialog)
  const reset = useStore(s => s.resetMemberProfile)
  const unlock = useStore(s => s.unlockMemberProfile)
  const note = useStore(s => s.noteProfileLock)
  const known = useStore(s => s.profileLocks[server]?.[user.username])
  const listed = useLook(server, user.username)
  // The card's facts say what is there to reset, and whether a lock runs.
  const [fetched, setFetched] = useState<MemberLook | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    api.userProfile(user.username, server).then(
      p => {
        if (!live) return
        setFetched(p.member?.profile ?? null)
        note(server, user.username, p.member?.profile_locked_until)
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [api, note, server, user.username])
  const now = useNow(known !== undefined, 30_000)
  const look = fetched === undefined ? listed : fetched
  return (
    <ProfileReset
      onClose={close}
      source={{
        user: shownUser(user, look),
        subtitle: `@${user.username}`,
        name: look?.name ?? null,
        lock: lockState(known, Math.floor(now / 1000)),
        reasons: true,
        avatar: accountAvatar,
        submit: (fields, secs, reason) => reset(server, user.username, fields, secs, reason),
        unlock: () => unlock(server, user.username),
      }}
    />
  )
}

// The hosted dialogs: your own server profile, and a moderator's reset of someone else's.
export default function ServerProfileDialogHost() {
  const dialog = useStore(s => s.activeDialog)
  const shown = useStore(s => s.settings.server_profiles !== false)
  if (!shown) return null
  if (dialog?.kind === 'server_profile')
    return <HostedProfileDialog key={dialog.server} server={dialog.server} />
  if (dialog?.kind === 'profile_reset')
    return (
      <HostedResetDialog
        key={`${dialog.server}\n${dialog.user.username}`}
        server={dialog.server}
        user={dialog.user}
      />
    )
  return null
}

// The "Server profiles" choice of a server's settings, the same for hosted servers and P2P
// servers: what members may set for themselves there.
export function ProfilesModeField({
  mode,
  disabled = false,
  onChange,
}: {
  mode: ProfilesMode
  disabled?: boolean
  onChange: (mode: ProfilesMode) => Promise<unknown>
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pick = (next: ProfilesMode) => {
    if (busy || next === mode) return
    setBusy(true)
    void onChange(next)
      .then(
        () => setError(null),
        (err: unknown) => setError(errorText(err))
      )
      .finally(() => setBusy(false))
  }
  return (
    <div data-profiles-mode className="flex flex-col gap-2">
      <div role="radiogroup" aria-label="Server profiles" className="flex flex-wrap gap-2">
        {PROFILE_FIELDS.modes.map(m => (
          <button
            key={m}
            role="radio"
            aria-checked={mode === m}
            disabled={disabled || busy}
            onClick={() => pick(m)}
            className={`${chip(mode === m)} disabled:opacity-50`}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>
      <p className="text-xs text-on-surface-variant">
        Members can set a name, avatar, banner and description that only this server shows. Turning
        it off hides what they set; it comes back when you turn it on again.
      </p>
      <FieldError message={error} />
    </div>
  )
}
