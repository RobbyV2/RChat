'use client'
import { Covered } from './covered'
import { ask, asked } from '../lib/asks'
import { Loaded, Refreshed, useAccountRequest, useAccountSource } from './loaded'
import type { Load } from '../lib/load'

import { asAccount, pictured, type Person } from '../lib/people'
import { Name, NameArea, NameInput } from './name'
import { handleName, p2pName, personCalled, personName, type NameValue } from '../lib/names'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Lock } from 'lucide-react'
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
import type { AvatarKind, ProfilesMode, ServerProfile, UserRef } from '../lib/types'
import { AvatarPicker } from './avatar_picker'
import { BannerPicker } from './settings_menu'
import { useLook } from './shown_user'
import { useNow } from './timeout_dialog'
import { Button, Chip } from './controls'
import { Grid, Row, Stack, Surface, Inset, Lift } from './layout'
import { Dialog, FieldError, Masked, fieldCls } from './ui'
import { UserAvatar } from './user_avatar'

const labelCls = 'text-sm text-on-surface-variant'
const boxCls = fieldCls.replace(' border-outline', '').replace(' focus:border-primary', '')

const when = (until: number) =>
  new Date(until * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

// Where the editor reads and writes a server profile: a hosted server through its routes, or a
// P2P server through the profile this device signs into it.
// What a place has stored for you there: its mode, whether members may set a name (the place's
// mode and, on a hosted server, the site's display names switch), your profile and its lock.
export interface StoredProfile {
  mode: ProfilesMode
  names: boolean
  saved: ProfileDraft
  lock: LockState
}

export interface ProfileEditorSource<P> {
  // Who you are there without a server profile.
  account: UserRef
  accountBio: string | null
  accountBanner: string | null
  // What the profile falls back to, in the words of the place ("account", "P2P profile").
  origin: string
  // What the place holds, as it loads, and how to read it.
  stored: Load<P>
  read: (stored: P) => StoredProfile
  // Draws someone's picture there.
  avatar: (user: Person, size: number) => ReactNode
  // Whether a name shows with the username after it.
  handles: boolean
  save: (from: ProfileDraft, to: ProfileDraft) => Promise<string | null>
  clear: () => Promise<string | null>
}

// The editor's source once what the place holds is here.
type Shown = Omit<ProfileEditorSource<unknown>, 'stored' | 'read'> & StoredProfile

function Preview({ source, draft }: { source: Shown; draft: ProfileDraft }) {
  const user = previewUser(source.account, draft, source.mode, source.names)
  const bio = shownBio(user, { bio: source.accountBio, server_bio: draft.bio.trim() || null })
  const banner = shownBanner(user, {
    banner_color: source.accountBanner,
    server_banner: draft.banner,
  })
  const name = source.handles ? (
    <Name
      of={personName(user, true)}
      withUsername
      as="p"
      look="truncate text-sm font-medium text-on-surface"
    />
  ) : (
    <Name
      of={p2pName(user.display_name, true)}
      as="p"
      look="truncate text-sm font-medium text-on-surface"
    />
  )
  return (
    <Grid data-profile-preview aria-label="Preview" role="group" cols={{ base: 1, sm: 2 }} gap="md">
      <Surface pad="md" gap="md" row tone="plain" align="stretch" look="bg-surface" place="min-w-0">
        <span className="shrink-0">{source.avatar(asAccount(user, 'editor'), 36)}</span>
        <div className="min-w-0">
          {name}
          <p className="text-sm text-on-surface-variant">How you look in messages here</p>
        </div>
      </Surface>
      <div className="min-w-0 overflow-hidden rounded-2xl bg-surface">
        <div aria-hidden style={{ background: banner }} className="h-10" />
        <Lift by="lg">
          <Inset row pad="md" inset="sides" gap="sm" align="end" place="min-w-0">
            <Surface
              as="span"
              pad="2xs"
              tone="plain"
              radius="full"
              look="bg-surface"
              place="shrink-0"
            >
              {source.avatar(user, 40)}
            </Surface>
            <Name
              of={personCalled(user.display_name, user.username, true)}
              look="truncate text-sm font-semibold text-on-surface"
            />
          </Inset>
        </Lift>
        <Inset pad="md" inset="bar">
          <Covered
            what="about"
            as="p"
            look="line-clamp-3 min-h-5 text-xs break-words whitespace-pre-wrap text-on-surface-variant"
          >
            {bio ? <Masked text={bio} own /> : null}
          </Covered>
        </Inset>
      </div>
    </Grid>
  )
}

// The editor of your own profile in one server. Each part is optional; a part left alone shows
// what your account (or P2P profile) has.
export function ProfileEditor<P>({
  source,
  onClose,
}: {
  source: ProfileEditorSource<P>
  onClose: () => void
}) {
  const { stored, read, ...rest } = source
  return (
    <Dialog title="Server profile" onClose={onClose} full>
      <Loaded load={stored} what="your server profile">
        {value => {
          const shown = { ...rest, ...read(value) }
          return shown.mode === 'off' ? (
            <p data-profile-off className="text-sm text-on-surface-variant">
              Server profiles are off in this server.
            </p>
          ) : (
            <Editor source={shown} onClose={onClose} />
          )
        }}
      </Loaded>
    </Dialog>
  )
}

function Editor({ source, onClose }: { source: Shown; onClose: () => void }) {
  const { saved, account, origin } = source
  const [draft, setDraft] = useState(saved)
  const [seen, setSeen] = useState(saved)
  if (!sameDraft(seen, saved)) {
    // The stored profile changed under the dialog (a reset, another device).
    const untouched = sameDraft(draft, seen)
    setSeen(saved)
    if (untouched) setDraft(saved)
  }
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameId = useId()
  const bioId = useId()
  const locked = source.lock.locked
  const line = lockLine(source.lock, when)
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
    <Stack
      as="form"
      data-server-profile
      onSubmit={e => {
        e.preventDefault()
        submit()
      }}
      gap="lg"
    >
      {line && (
        <Surface
          as="p"
          data-profile-locked
          role="status"
          pad="md"
          inset="bar"
          tone="error"
          radius="lg"
        >
          <Row as="span" gap="sm" align="start">
            <Lock size={16} className="shrink-0" aria-hidden />
            <span className="text-sm">{line}</span>
          </Row>
        </Surface>
      )}
      <Preview source={source} draft={shown} />
      <Stack as="fieldset" disabled={locked || busy} gap="lg">
        {source.names ? (
          <Stack gap="sm">
            <label htmlFor={nameId} className={labelCls}>
              Server name
            </label>
            <Row gap="sm" align="stretch">
              <NameInput
                id={nameId}
                value={draft.name}
                maxLength={PROFILE_FIELDS.name.max * 2}
                onChange={e => change({ name: e.target.value })}
                placeholder={account.display_name}
                autoComplete="off"
                className={`${boxCls} min-w-0 flex-1 border-outline focus:border-primary`}
              />
              {draft.name !== '' && (
                <Button onClick={() => change({ name: '' })}>Use {origin} name</Button>
              )}
            </Row>
            <p className="text-xs text-on-surface-variant">
              Only this server shows it. Leave it empty to use your {origin} name.
            </p>
          </Stack>
        ) : (
          <p data-profile-no-names className="text-sm text-on-surface-variant">
            {source.mode === 'no_names'
              ? "This server doesn't use server names."
              : 'Names are off on this site.'}
          </p>
        )}
        <Stack gap="sm">
          {draft.avatar === null ? (
            <Row gap="md" wrap>
              <span className={labelCls}>Avatar</span>
              {source.avatar(asAccount(account, 'editor'), 32)}
              <span className="text-xs text-on-surface-variant">As on your {origin}</span>
              <Button
                onClick={() =>
                  change({
                    avatar: {
                      kind: account.avatar_kind,
                      color: account.avatar_color ?? (kind === 'color' ? DEFAULT_COLOR : null),
                    },
                  })
                }
              >
                Change for this server
              </Button>
            </Row>
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
                  source.avatar(pictured(account.username, { kind: k, color: c }, 'editor'), 48)
                }
                disabled={locked || busy}
              />
              <Button onClick={() => change({ avatar: null })} place="self-start">
                Use {origin} avatar
              </Button>
            </>
          )}
        </Stack>
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
        <Stack gap="sm">
          <label htmlFor={bioId} className={labelCls}>
            Description
          </label>
          <NameArea
            id={bioId}
            rows={3}
            value={draft.bio}
            onChange={e => change({ bio: e.target.value })}
            placeholder={source.accountBio ?? 'Tell this server a little about yourself'}
            aria-invalid={left < 0}
            aria-describedby={`${bioId}-count`}
            className={`${boxCls} resize-none ${
              left < 0 ? 'border-error' : 'border-outline focus:border-primary'
            }`}
          />
          <Row gap="md" justify="between">
            {draft.bio !== '' ? (
              <Button onClick={() => change({ bio: '' })}>Use {origin} description</Button>
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
          </Row>
        </Stack>
      </Stack>
      <FieldError message={error ?? (changed ? invalid : null)} />
      <Row gap="sm" justify="between" wrap>
        <Button
          variant="danger"
          size="md"
          disabled={locked || busy || emptyDraft(saved)}
          onClick={() => void finish(source.clear)}
        >
          Reset all
        </Button>
        <Row as="span" gap="sm">
          <Button size="md" onClick={onClose}>
            {locked ? 'Close' : 'Cancel'}
          </Button>
          {!locked && (
            <Button
              type="submit"
              variant="filled"
              size="md"
              disabled={busy || !changed || invalid !== null}
            >
              Save
            </Button>
          )}
        </Row>
      </Row>
    </Stack>
  )
}

export const accountAvatar = (user: Person, size: number) => (
  <UserAvatar person={user} size={size} />
)

function HostedProfileDialog({ server }: { server: string }) {
  const close = useStore(s => s.closeDialog)
  const me = useStore(s => s.me)
  const stored = useStore(s => s.servers[server]?.my_profile)
  const displayNames = useStore(s => s.settings.display_names !== false)
  const save = useStore(s => s.saveMyProfile)
  const clear = useStore(s => s.clearMyProfile)
  // Read when the dialog opens: a lock or a reset may be newer than what the page holds, and a
  // server that isn't open here holds nothing. What the page learns meanwhile replaces it.
  const [load, source] = useAccountSource(() => ask.serverProfile(server), [server])
  useEffect(() => {
    if (stored) source.change(() => stored)
  }, [source, stored])
  const now = useNow(true, 30_000)
  if (!me) return null
  const then = async (run: Promise<string | null>) => {
    const err = await run
    source.refresh()
    return err
  }
  return (
    <ProfileEditor
      onClose={close}
      source={{
        account: me,
        accountBio: me.bio,
        accountBanner: me.banner_color,
        origin: 'account',
        stored: load,
        read: (mine: ServerProfile) => ({
          mode: mine.mode,
          names: mine.mode === 'all' && displayNames,
          saved: draftOfProfile(mine),
          lock: lockState(mine.locked_until, Math.floor(now / 1000)),
        }),
        avatar: accountAvatar,
        handles: true,
        save: (from, to) => then(save(server, patchOf(from, to))),
        clear: () => then(clear(server)),
      }}
    />
  )
}

// Where the reset dialog reads a member's server profile and sends the reset.
export interface ProfileResetSource {
  // The member as the server shows them now, and the line under that name: their @username on
  // a hosted server, the name a P2P member gives themselves (null: none).
  user: UserRef
  subtitle: NameValue | null
  // The server name a reset of the name removes; null when they have none.
  name: string | null
  lock: LockState
  // Whether the reset keeps a reason (a hosted server's audit log does).
  reasons: boolean
  avatar: (user: Person, size: number) => ReactNode
  submit: (fields: ResetField[], secs: LockSecs, reason: string) => Promise<string | null>
  unlock: () => Promise<unknown>
}

// A moderator clears parts of someone's server profile and may lock it for a while.
export function ProfileReset({
  source,
  notice = null,
  onClose,
}: {
  source: ProfileResetSource
  // The state of a lookup the dialog's facts wait on.
  notice?: ReactNode
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
      <Stack data-profile-reset gap="lg">
        <Row gap="md">
          {source.avatar(asAccount(user, 'editor'), 36)}
          <div className="min-w-0">
            <Name
              as="p"
              of={personCalled(user.display_name)}
              look="truncate text-sm font-medium text-on-surface"
            />
            {source.subtitle !== null && (
              <Name
                as="p"
                of={source.subtitle}
                before={source.subtitle.kind === 'person' ? '@' : undefined}
                data-profile-reset-who
                look="truncate text-xs text-on-surface-variant"
              />
            )}
          </div>
        </Row>
        <p className="text-sm text-on-surface-variant">
          What you reset goes back to what their profile has outside this server.
        </p>
        {lock.locked && (
          <Surface data-profile-reset-locked pad="md" inset="bar" tone="error" radius="lg">
            <Row gap="sm" wrap>
              <Lock size={16} className="shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 text-sm">
                {lock.until === null ? 'Locked until unlocked' : `Locked until ${when(lock.until)}`}
              </span>
              <Button
                variant="danger"
                onClick={() => {
                  void source.unlock()
                  onClose()
                }}
              >
                Unlock
              </Button>
            </Row>
          </Surface>
        )}
        <Stack as="fieldset" gap="2xs">
          <legend className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
            Reset
          </legend>
          {RESET_FIELDS.map(f => (
            <label key={f} className="flex min-h-9 items-center text-sm text-on-surface">
              <Row as="span" gap="md">
                <input
                  type="checkbox"
                  checked={fields.includes(f)}
                  onChange={() => toggle(f)}
                  className="size-4 accent-primary"
                />
                <span className="min-w-0">
                  {RESET_LABELS[f]}
                  {f === 'name' && source.name !== null && (
                    <Name
                      of={personCalled(source.name)}
                      before=" ("
                      after=")"
                      look="text-on-surface-variant"
                    />
                  )}
                </span>
              </Row>
            </label>
          ))}
        </Stack>
        <Stack gap="sm">
          <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
            Lock their server profile
          </p>
          <Stack gap="xs">
            <Row role="radiogroup" aria-label="Lock" gap="sm" wrap>
              {LOCK_CHOICES.map(c => (
                <Chip
                  key={String(c.secs)}
                  radio
                  on={secs === c.secs}
                  onClick={() => setSecs(c.secs)}
                >
                  {c.label}
                </Chip>
              ))}
            </Row>
            <p className="text-xs text-on-surface-variant">
              While it is locked they can&apos;t change their server profile.
            </p>
          </Stack>
        </Stack>
        {source.reasons && (
          <label className="block text-xs font-medium tracking-wide text-on-surface-variant uppercase">
            <Stack as="span" gap="xs">
              Reason
              <input
                value={reason}
                maxLength={REASON_MAX}
                onChange={e => setReason(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void submit()
                }}
                placeholder="Optional, shown to moderators"
                className={`${fieldCls} w-full tracking-normal text-on-surface normal-case`}
              />
            </Stack>
          </label>
        )}
        {notice}
        <FieldError message={error} />
        <Row gap="sm" justify="end">
          <Button size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="filled-danger"
            size="md"
            disabled={!ready || busy}
            onClick={() => void submit()}
          >
            {fields.length ? 'Reset' : 'Lock'}
          </Button>
        </Row>
      </Stack>
    </Dialog>
  )
}

function HostedResetDialog({ server, user }: { server: string; user: UserRef }) {
  const close = useStore(s => s.closeDialog)
  const reset = useStore(s => s.resetMemberProfile)
  const unlock = useStore(s => s.unlockMemberProfile)
  const note = useStore(s => s.noteProfileLock)
  const known = useStore(s => s.profileLocks[server]?.[user.username])
  const listed = useLook(server, user.username)
  // The card's facts say what is there to reset, and whether a lock runs.
  const load = useAccountRequest(
    () =>
      asked(ask.userProfile(user.username, server), p => {
        note(server, user.username, p.member?.profile_locked_until)
        return p.member?.profile ?? null
      }),
    [note, server, user.username]
  )
  const now = useNow(known !== undefined, 30_000)
  return (
    <Refreshed load={load} known={listed} what="their server profile">
      {(look, notice) => (
        <ProfileReset
          onClose={close}
          notice={notice}
          source={{
            user: shownUser(user, look),
            subtitle: handleName(user.username),
            name: look?.name ?? null,
            lock: lockState(known, Math.floor(now / 1000)),
            reasons: true,
            avatar: accountAvatar,
            submit: (fields, secs, reason) => reset(server, user.username, fields, secs, reason),
            unlock: () => unlock(server, user.username),
          }}
        />
      )}
    </Refreshed>
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
    <Stack data-profiles-mode gap="sm">
      <Row role="radiogroup" aria-label="Server profiles" gap="sm" wrap>
        {PROFILE_FIELDS.modes.map(m => (
          <Chip key={m} radio on={mode === m} disabled={disabled || busy} onClick={() => pick(m)}>
            {MODE_LABELS[m]}
          </Chip>
        ))}
      </Row>
      <p className="text-xs text-on-surface-variant">
        Members can set a name, avatar, banner and description that only this server shows. Turning
        it off hides what they set; it comes back when you turn it on again.
      </p>
      <FieldError message={error} />
    </Stack>
  )
}
