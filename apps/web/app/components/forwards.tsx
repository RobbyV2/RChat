'use client'
import type { ForwardDestination, ForwardSource } from '../lib/forward'
import type { AccountSession } from '../lib/client/session'

import { useAccount, useStoreApi } from '../lib/client/react'
import { useP2p, useP2pApp } from '../lib/client/p2p_react'
import { useEffect, useMemo, useReducer, useState, useSyncExternalStore } from 'react'
import {
  ChevronRight,
  Forward,
  Hash,
  Image as ImageIcon,
  Lock,
  MapPin,
  SendHorizontal,
} from 'lucide-react'
import { useMask, useStore } from '../lib/store'
import { textOnlyDestination } from '../lib/channel_content'
import { clipAllowed, clipSourceNames, sourceAccess } from '../lib/forward_viewing'
import { useForwardAccess, useLocated } from '../lib/forward_access'
import { locateFailed, locateOnce } from '../lib/forward_locate'
import { forwardPending, forwardSourceDefault, instanceServer, shownSource } from '../lib/forward'
import {
  PENDING,
  carriedOf,
  forwardPill,
  hostedPill,
  needsLookup,
  p2pPill,
  vouchedFiles,
  vouches,
  type ForwardPill,
  type PlaceNames,
} from '../lib/forward_pill'
import type { FwdPlace } from '../lib/p2p/content'
import type { P2pApp } from '../lib/p2p/app/runtime'
import { ownsP2pServer } from '../lib/p2p/server/types'
import { serverInitial } from '../lib/rules'
import type { ForwardRef, Message, UserRef } from '../lib/types'
import type { ToolbarAction } from './message_toolbar'
import { ComposerBar, SpoilerLine } from './replies'
import { snippetParts } from '../lib/replies'
import { MarkdownMessage } from './markdown_message'
import { UserAvatar } from './user_avatar'
import { profileTrigger } from './profile_card'
import { RevealChannelPreview } from './preview_reveal'
import { BlockedQuote } from './blocking'
import { MessageTime } from './timestamp'
import { PollCard } from './poll_card'
import { fullTimeOf, plainStamps } from '../lib/timestamps'
import { Button, LinkButton } from './controls'
import { Masked, useOwnServer } from './ui'
import { NameWithUsername } from './display_name'
import { WebhookBadge } from './webhooks'
import { isWebhookAuthor } from '../lib/webhooks'
import { useInstanceLabel } from './instance_badge'
import { ServerGlyph } from './server_rail'
import { useStableSelector } from '../lib/stable_key'
import type { P2pState } from '../lib/p2p/app/store'
import { Row, Stack } from './layout'

const DELETED_USER = 'Deleted user'

export const forwardAction = (onClick: () => void): ToolbarAction => ({
  key: 'forward',
  label: 'Forward',
  icon: Forward,
  onClick,
})

const noSubscription = () => () => {}

function usePeerSource(account: AccountSession, source?: ForwardSource) {
  const peer = () =>
    source?.kind === 'p2p' || (source?.kind === 'direct' && source.identity)
      ? account.identities.get(source.identity)
      : undefined
  const app = useSyncExternalStore(account.identities.subscribe, peer, peer)
  const servers = () => app?.useP2p.getState().servers
  useSyncExternalStore(app?.useP2p.subscribe ?? noSubscription, servers, servers)
}

export const useForwardClip = () => {
  const ownerSession = useAccount()
  ownerSession.viewing.useViewing(s => s.revision)
  const clip = useStore(s => s.forwardClip)
  usePeerSource(ownerSession, clip?.source)
  usePeerSource(ownerSession, clip?.quoted)
  const allowed = useStore(s => !!clip && clipAllowed(s, clip, ownerSession))
  useEffect(() => {
    for (const origin of [clip?.source, clip?.quoted])
      if (
        origin?.kind === 'channel' &&
        origin.server &&
        sourceAccess(ownerSession.store.getState(), origin, undefined, ownerSession) === 'unknown'
      )
        void ownerSession.store
          .getState()
          .discoverChannels(origin.server)
          .catch(() => {})
  }, [ownerSession, clip, allowed])
  return allowed ? clip : null
}

const SHOW_SOURCE = "Show where it's from"

// Whether the sender owns the clip's source server: its names are their own text.
const useOwnSource = (account: AccountSession, source?: ForwardSource) => {
  const hosted = useOwnServer(source?.kind === 'channel' ? (source.server ?? null) : null)
  if (source?.kind !== 'p2p') return hosted
  const app = account.identities.get(source.identity)
  const st = app?.useP2p.getState()
  return !!st && ownsP2pServer(st.servers[source.room], st.me)
}

// The bar above a composer while the forward clipboard has a message. Send forwards it here. X
// clears the clipboard. The switch says whether the copy names where it's from.
// `onSend` sends it somewhere other than an instance conversation (a P2P one, `destination`).
export function ForwardBar({
  draftKey,
  onSend,
  destination,
}: {
  draftKey: string
  onSend?: (showSource: boolean) => void
  destination?: ForwardDestination
}) {
  const account = useAccount()
  const store = useStoreApi()
  const clip = useForwardClip()
  const textOnly = useStore(s => !onSend && textOnlyDestination(s, draftKey))
  const blocked = textOnly && !clip?.p2p && (clip?.has_media || clip?.has_poll)
  const busy = useStore(s => (clip ? forwardPending(s.outbox[draftKey], clip.id) : false))
  const sendForward = useStore(s => s.sendForward)
  const clearForward = useStore(s => s.clearForward)
  const setShowSource = useStore(s => s.setForwardShowSource)
  const me = useStore(s => s.me?.username ?? null)
  const server = useStore(s => (destination ? null : instanceServer(s, draftKey)))
  const to: ForwardDestination = destination ?? { kind: 'instance', server }
  const fallback = useStore(s => (clip ? forwardSourceDefault(clip, to, s, s.settings) : null))
  const chosen = useStore(s =>
    s.forwardShowSource?.key === draftKey ? s.forwardShowSource.on : null
  )
  // What the server says a copy that shows its source would name.
  const hosted = !!clip && !clip.p2p && clip.source?.kind === 'channel'
  const located = useLocated(clip?.id, hosted)
  const failed = useStore(
    () => hosted && !!clip && located === undefined && locateFailed(account, clip.id)
  )
  const [, retried] = useReducer((n: number) => n + 1, 0)
  const ownSource = useOwnSource(account, clip?.source)
  const { label: instance } = useInstanceLabel()
  if (!clip) return null
  const own = !clip.p2p && clip.author !== null && clip.author.username === me
  const show = fallback === null ? null : (chosen ?? fallback)
  const known = !hosted || located !== undefined
  // Shown names wait for the server's answer; Send waits with them.
  const waiting = show === true && !known
  const shown = show === null ? null : shownSource(clipSourceNames(account, clip), show)
  const retry = () => void locateOnce(account, clip.id).then(retried)
  // A P2P message stored only on two devices: copying it to the instance needs a yes first.
  const send = () =>
    onSend
      ? onSend(show ?? false)
      : clip.p2p
        ? store.getState().askConfirm({
            title: 'Forward',
            body: `This copies the message to ${instance}.`,
            confirm: 'Copy',
            action: () => {
              if (store.getState().forwardClip === clip) sendForward(draftKey)
            },
          })
        : sendForward(draftKey, show ?? undefined)
  return (
    <ComposerBar
      onClose={clearForward}
      closeLabel="Discard forward"
      actions={
        <>
          {show !== null && (
            <button
              type="button"
              role="switch"
              aria-checked={show}
              title={SHOW_SOURCE}
              aria-label={SHOW_SOURCE}
              onClick={() => setShowSource(draftKey, !show)}
              className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary pointer-coarse:min-h-10 pointer-coarse:min-w-10 pointer-coarse:justify-center ${
                show
                  ? 'bg-secondary-container text-on-secondary-container hover:opacity-90'
                  : 'text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface'
              }`}
            >
              <MapPin size={12} aria-hidden className="shrink-0" />
              <span className="@max-sm:hidden">{SHOW_SOURCE}</span>
            </button>
          )}
          <Button
            variant="filled"
            icon={SendHorizontal}
            title={
              blocked
                ? 'This channel only accepts text'
                : waiting
                  ? "Checking where it's from"
                  : 'Forward here'
            }
            disabled={busy || blocked || waiting}
            onClick={send}
            place="shrink-0"
          >
            Send
          </Button>
        </>
      }
    >
      <Row as="span" gap="sm" data-forward-bar>
        <Forward size={14} className="shrink-0 text-primary" />
        <span className="shrink-0">
          Forward{' '}
          {clip.author ? (
            <span className="streamer font-semibold text-on-surface">
              <NameWithUsername user={clip.author} own={own} />
            </span>
          ) : (
            <span className="font-semibold text-on-surface">{DELETED_USER}</span>
          )}
          &apos;s message
        </span>
        <Row as="span" gap="2xs">
          <span className="truncate text-xs">
            <SpoilerLine
              key={JSON.stringify([me, clip.source, clip.id])}
              parts={snippetParts(plainStamps(clip.snippet))}
              own={own}
            />
          </span>
          {clip.has_media && <ImageIcon size={12} className="shrink-0" aria-label="Attachment" />}
        </Row>
      </Row>
      {show !== null && (
        <span data-forward-source className="block truncate text-xs">
          {waiting ? (
            failed ? (
              <>
                Couldn&apos;t check where it&apos;s from.{' '}
                <LinkButton onClick={retry}>Retry</LinkButton>
              </>
            ) : (
              "Checking where it's from"
            )
          ) : shown ? (
            <>
              From{' '}
              <span className="streamer font-semibold text-on-surface">
                <Masked text={shown.server} own={ownSource} />
              </span>
              {shown.channel !== null && (
                <>
                  {' > #'}
                  <span className="streamer font-semibold text-on-surface">
                    <Masked text={shown.channel} own={ownSource} />
                  </span>
                </>
              )}
            </>
          ) : (
            "Where it's from stays hidden"
          )}
        </span>
      )}
    </ComposerBar>
  )
}

const PILL =
  'mt-2 flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-outline-variant/70 bg-surface-container-high px-2.5 py-1 text-xs text-on-surface-variant'
const PLACE = 'streamer flex min-w-0 items-center gap-1 rounded-sm font-semibold text-on-surface'
const PLACE_BUTTON = `${PLACE} cursor-pointer hover:underline focus-visible:outline-2 focus-visible:outline-primary pointer-coarse:min-h-8`
const CANT_OPEN = "You can't open this"

function P2pInitial({ name, own }: { name: string; own: boolean }) {
  const mask = useMask(own)
  return <span className="streamer">{serverInitial(mask(name))}</span>
}

function PillGlyph({ server, own }: { server: PlaceNames['server']; own: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-sm text-3xs leading-none font-semibold ${
        server.p2p
          ? 'bg-tertiary-container text-on-tertiary-container'
          : 'bg-primary-container text-on-primary-container'
      }`}
    >
      {server.p2p ? (
        <P2pInitial name={server.name} own={own} />
      ) : (
        <ServerGlyph name={server.key} displayName={server.name} />
      )}
    </span>
  )
}

// "Forwarded from" a server and channel the viewer can open, a direct message, names the copy
// carries that the viewer can't open, or somewhere the viewer can't access. A frame shows it
// without buttons.
export function ForwardSourcePill({
  pill,
  when,
  own = false,
  frame = false,
  openServer,
  openOriginal,
}: {
  pill: ForwardPill
  // The original's full time, for the button that opens it.
  when: string
  // The viewer owns the source server: its names are their own text.
  own?: boolean
  frame?: boolean
  openServer?: () => void
  openOriginal?: () => void
}) {
  const streamer = useStore(s => s.streamer)
  const mask = useMask(own)
  const original = `Open the original message, sent ${when}`
  if (pill.kind === 'none') return null
  const head = <span className="shrink-0">Forwarded from</span>
  const stop = (run?: () => void) => (e: { stopPropagation(): void }) => {
    e.stopPropagation()
    run?.()
  }
  if (pill.kind === 'open') {
    const { server, channel } = pill
    const serverName = (
      <>
        <PillGlyph server={server} own={own} />
        <span className="min-w-0 truncate">
          <Masked text={server.name} own={own} />
        </span>
      </>
    )
    const channelName = channel && (
      <>
        <Hash size={12} aria-hidden className="shrink-0" />
        <span className="min-w-0 truncate">
          <Masked text={channel.name} own={own} />
        </span>
      </>
    )
    return (
      <div data-forward-pill="open" className={PILL}>
        {head}
        {frame || !openServer ? (
          <span className={`${PLACE} max-w-[45%]`}>{serverName}</span>
        ) : (
          <button
            type="button"
            title={streamer ? 'Open server' : `Open ${mask(server.name)}`}
            onClick={stop(openServer)}
            className={`${PLACE_BUTTON} max-w-[45%]`}
          >
            {serverName}
          </button>
        )}
        {channel && (
          <>
            <ChevronRight size={12} aria-hidden className="shrink-0" />
            {frame || !openOriginal ? (
              <span className={PLACE}>{channelName}</span>
            ) : (
              <button
                type="button"
                title={original}
                onClick={stop(openOriginal)}
                className={PLACE_BUTTON}
              >
                {channelName}
              </button>
            )}
          </>
        )}
      </div>
    )
  }
  if (pill.kind === 'dm')
    return (
      <div data-forward-pill="dm" className={PILL}>
        {head}
        {pill.open && !frame && openOriginal ? (
          <button
            type="button"
            title={original}
            onClick={stop(openOriginal)}
            className="min-w-0 truncate rounded-sm font-semibold text-on-surface hover:underline focus-visible:outline-2 focus-visible:outline-primary pointer-coarse:min-h-8"
          >
            a direct message
          </button>
        ) : (
          <span className="min-w-0 truncate">a direct message</span>
        )}
      </div>
    )
  if (pill.kind === 'named')
    return (
      <div data-forward-pill="named" className={PILL}>
        {head}
        <span className={`${PLACE} max-w-[45%]`}>
          <span className="min-w-0 truncate">
            <Masked text={pill.server} />
          </span>
        </span>
        {pill.channel !== null && (
          <>
            <ChevronRight size={12} aria-hidden className="shrink-0" />
            <span className={PLACE}>
              <Hash size={12} aria-hidden className="shrink-0" />
              <span className="min-w-0 truncate">
                <Masked text={pill.channel} />
              </span>
            </span>
          </>
        )}
        {!pill.pending && !frame && (
          <span
            role="img"
            title={CANT_OPEN}
            aria-label={CANT_OPEN}
            className="flex shrink-0 text-on-surface-variant"
          >
            <Lock size={11} aria-hidden />
          </span>
        )}
      </div>
    )
  return (
    <div data-forward-pill="hidden" className={PILL}>
      {head}
      <span className="min-w-0 truncate">somewhere you can&apos;t access</span>
    </div>
  )
}

// The pill of an instance copy, from the viewer's own lookup of its original.
// Servers reloaded for a copy whose original's channel they lacked, per account session.
const reloadedServers = new WeakMap<object, Set<string>>()

function HostedSourcePill({ m, when, active }: { m: Message; when: string; active: boolean }) {
  const owner = useAccount()
  const store = owner.store
  const openForward = useStore(s => s.openForward)
  const openServer = useStore(s => s.openServer)
  const servers = useStore(s => s.servers)
  const located = useLocated(m.forward?.source_id, active && needsLookup({ servers }, m))
  const pill = active ? hostedPill({ servers }, m, located) : NO_PILL
  const own = useOwnServer(pill.kind === 'open' ? pill.server.key : null)
  // The original's server loads when it isn't here, and reloads once a session when it lacks the
  // channel.
  const at = located?.kind === 'channel' ? located : null
  const listed = !!at && !!servers[at.server]
  const absent = !!at && !servers[at.server]?.channels.some(c => c.id === at.id)
  const server = at?.server
  useEffect(() => {
    if (!absent || !server) return
    if (listed) {
      const mark = owner.lifetime.sessionMark()
      const done = reloadedServers.get(mark) ?? new Set<string>()
      reloadedServers.set(mark, done)
      if (done.has(server)) return
      done.add(server)
    }
    void store
      .getState()
      .discoverChannels(server, listed)
      .catch(() => {})
  }, [owner, store, absent, listed, server])
  return (
    <ForwardSourcePill
      pill={pill}
      when={when}
      own={own}
      openServer={pill.kind === 'open' ? () => void openServer(pill.server.key) : undefined}
      openOriginal={() => void openForward(m)}
    />
  )
}

const NO_PILL: ForwardPill = { kind: 'none' }

const noHeld = () => () => {}

// Where this identity holds a P2P copy's original and whether it vouches for the copy: looked up
// once per event (the identity reads it again when an edit or a redaction aimed at it arrives),
// and shown as the current state allows. `author`: the viewer's own name for the original's
// author, once it vouches.
const useP2pOrigin = (place: FwdPlace | undefined) => {
  const app = useP2pApp()
  const ev = place?.ev ?? null
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const rev = () => app?.heldRevision() ?? 0
  useSyncExternalStore(app?.onHeld ?? noHeld, rev, rev)
  useEffect(() => {
    if (!app || !ev) return
    let live = true
    void app.locateEvent(ev).then(() => {
      if (live) redraw()
    })
    return () => {
      live = false
    }
  }, [app, ev])
  const origin = useP2p(
    useStableSelector((s: P2pState): { pill: ForwardPill; author: UserRef | null } => {
      if (!place) return { pill: NO_PILL, author: null }
      const at = app && ev ? app.eventPlace(ev) : null
      const pill = p2pPill(place, at, s.servers)
      const author = app && at && vouches(place, at) ? app.heldAuthor(at) : null
      return { pill, author }
    })
  )
  // A vouched copy's files show as its original holds them.
  const at = origin.author && app && ev ? app.eventPlace(ev) : null
  const atts = useMemo(() => (place && at ? vouchedFiles(place, at) : null), [place, at])
  return { app, ...origin, atts }
}

// The files of a P2P copy as its original holds them, once the original vouches for the copy.
export const useVouchedFiles = (place: FwdPlace | undefined) => useP2pOrigin(place).atts

// Opens the original, or its server, only while it vouches for the copy.
const vouched = (app: P2pApp, f: FwdPlace) => {
  const at = f.ev ? app.eventPlace(f.ev) : null
  return at && f.ev && vouches(f, at) ? { ...at, ev: f.ev } : null
}

const p2pOpenOriginal = (app: P2pApp, f: FwdPlace) => {
  const at = vouched(app, f)
  if (at) void app.p2pOpenAt(at.room, at.ch, at.ev)
}

const p2pOpenRoom = (app: P2pApp, f: FwdPlace) => {
  const at = vouched(app, f)
  if (at && at.ch !== null) void app.p2pServer.open(at.room)
}

function P2pPillOf({
  app,
  pill,
  place,
  when,
}: {
  app: P2pApp | null
  pill: ForwardPill
  place: FwdPlace
  when: string
}) {
  const own = useP2p(s => pill.kind === 'open' && ownsP2pServer(s.servers[pill.server.key], s.me))
  if (!app) return null
  return (
    <ForwardSourcePill
      pill={pill}
      when={when}
      own={own}
      openServer={() => p2pOpenRoom(app, place)}
      openOriginal={() => p2pOpenOriginal(app, place)}
    />
  )
}

// The pill of a P2P copy, from what the viewer's identity holds.
export function P2pSourcePill({ place, when }: { place: FwdPlace; when: string }) {
  const { app, pill } = useP2pOrigin(place)
  return <P2pPillOf app={app} pill={pill} place={place} when={when} />
}

// A frame's pill: what the copy names, without lookups or buttons.
export function FrameForwardPill({ fwd }: { fwd: ForwardRef }) {
  const carried = carriedOf(fwd)
  const pill = forwardPill(carried, carried.dm ? { kind: 'dm', mine: false } : PENDING, () => null)
  return <ForwardSourcePill pill={pill} when={fullTimeOf(fwd.created_at)} frame />
}

// A forwarded message: a label and a card with a compact copy of the original. The pill under it
// says where the original is, and opens it if you can read it.
export function ForwardCard({
  m,
  canDelete,
  sending = false,
  local = false,
}: {
  m: Message
  canDelete: boolean
  sending?: boolean
  // A snapshot in a P2P conversation: its pill comes from the viewer's identity.
  local?: boolean
}) {
  const store = useStoreApi()
  const openForward = useStore(s => s.openForward)
  const fwd = m.forward
  const blocked = useStore(s => (fwd?.author ? s.blocked[fwd.author.username] === true : false))
  const [shown, setShown] = useState(false)
  const { access, target } = useForwardAccess(m, { active: (!blocked || shown) && !local })
  const origin = useP2pOrigin(local ? fwd?.p2p : undefined)
  if (!fwd) return null
  const author = origin.author ?? fwd.author
  const when = fullTimeOf(fwd.created_at)
  const head = (
    <div className="flex items-center gap-1 text-xs text-on-surface-variant italic">
      <Forward size={12} className="shrink-0" />
      Forwarded
    </div>
  )
  if (blocked && !shown)
    return (
      <Stack gap="2xs" data-forward={fwd.source_id}>
        {head}
        <div className="max-w-160 min-w-0 rounded-xl border border-outline-variant bg-surface-container px-3 py-2">
          <BlockedQuote onShow={() => setShown(true)} />
        </div>
      </Stack>
    )
  if (!local && access !== 'open')
    return (
      <div data-forward={fwd.source_id} className="min-w-0 text-sm text-on-surface-variant">
        Forwarded message · {target && <RevealChannelPreview target={target} />}{' '}
        <button
          type="button"
          className="min-h-8 cursor-pointer underline"
          disabled={sending}
          onClick={() => void openForward(m)}
        >
          Open original
        </button>
      </div>
    )
  return (
    <Stack gap="2xs" data-forward={fwd.source_id}>
      {head}
      <div className="max-w-160 min-w-0 rounded-xl border border-outline-variant bg-surface-container px-3 py-2">
        <Row gap="sm" wrap place="min-w-0">
          <Row as="span" gap="sm" place="max-w-full" data-forward-author>
            {author ? (
              <>
                <span
                  {...(local ? {} : profileTrigger(store, author, null, false))}
                  title={local ? undefined : 'View profile'}
                  className={`block shrink-0 rounded-full ${local ? '' : 'cursor-pointer hover:opacity-85'}`}
                >
                  <UserAvatar
                    username={author.username}
                    avatarKind={author.avatar_kind}
                    avatarColor={author.avatar_color}
                    size={20}
                  />
                </span>
                <span
                  {...(local ? {} : profileTrigger(store, author, null))}
                  className={`streamer min-w-0 truncate rounded-sm text-sm font-medium ${local ? '' : 'cursor-pointer outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary'}`}
                >
                  <NameWithUsername user={author} />
                </span>
                {isWebhookAuthor(author.username) && <WebhookBadge />}
              </>
            ) : (
              <>
                <UserAvatar username="" avatarKind="color" avatarColor={null} size={20} />
                <span
                  data-forward-deleted
                  className="min-w-0 truncate text-sm font-medium text-on-surface-variant italic"
                >
                  {DELETED_USER}
                </span>
              </>
            )}
          </Row>
          <MessageTime ts={fwd.created_at} className="shrink-0 text-xs text-on-surface-variant" />
        </Row>
        {m.poll?.snapshot ? (
          <PollCard m={m} />
        ) : (
          <MarkdownMessage message={m} canDelete={canDelete} />
        )}
        {fwd.dropped && (
          <p className="mt-1 text-xs text-on-surface-variant italic">
            File not forwarded: {fwd.dropped}
          </p>
        )}
        {local ? (
          fwd.p2p && <P2pPillOf app={origin.app} pill={origin.pill} place={fwd.p2p} when={when} />
        ) : (
          <HostedSourcePill m={m} when={when} active={!sending} />
        )}
      </div>
    </Stack>
  )
}
