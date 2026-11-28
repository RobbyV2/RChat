'use client'
import type { ComposerList } from '../lib/place/composer'
import { useLive } from '../lib/place/react'
import { useCompose } from '../lib/place/use_composer'
import { Covered } from './covered'
import { asAccount, pictured } from '../lib/people'
import { labelWith, personName, serverCalled } from '../lib/names'
import { Name, useNameLabels } from './name'
import type { ForwardSource } from '../lib/forward'
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
import { clipAllowed, clipSourceNames, sourceAccess } from '../lib/forward_viewing'
import { useForwardAccess, useLocated } from '../lib/forward_access'
import { locateFailed, locateOnce } from '../lib/forward_locate'
import { forwardPending, forwardSourceDefault, shownSource } from '../lib/forward'
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
import { ProfileButton } from './profile_card'
import { RevealChannelPreview } from './preview_reveal'
import { BlockedQuote } from './blocking'
import { MessageTime } from './timestamp'
import { PollCard } from './poll_card'
import { fullTimeOf, plainStamps } from '../lib/timestamps'
import { Button, LinkButton, Chip } from './controls'
import { Masked, useOwnServer } from './ui'
import { WebhookBadge } from './webhooks'
import { isWebhookAuthor } from '../lib/webhooks'
import { useInstanceLabel } from './instance_badge'
import { ServerGlyph } from './server_rail'
import { useStableSelector } from '../lib/stable_key'
import type { P2pState } from '../lib/p2p/app/store'
import { Row, Stack, Surface } from './layout'
import { sourcePillLook } from '../lib/controls'
import { sourcePlaceLook } from '../lib/controls'

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
// `sent` runs once a copy went out at once.
export function ForwardBar({ list, sent }: { list: ComposerList; sent?: () => void }) {
  const account = useAccount()
  const store = useStoreApi()
  const clip = useForwardClip()
  const compose = useCompose(list)
  const to = useLive(compose.forwardTo)
  const draftKey = to?.key ?? ''
  const onInstance = to?.destination.kind !== 'p2p'
  // A copy from a device to the instance carries no files or poll: text fits anywhere.
  const blocked =
    !!to?.textOnly && !(onInstance && clip?.p2p) && (clip?.has_media || clip?.has_poll)
  const busy = useStore(s => (clip ? forwardPending(s.outbox[draftKey], clip.id) : false))
  const clearForward = useStore(s => s.clearForward)
  const setShowSource = useStore(s => s.setForwardShowSource)
  const me = useStore(s => s.me?.username ?? null)
  const fallback = useStore(s =>
    clip && to ? forwardSourceDefault(clip, to.destination, s, s.settings) : null
  )
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
  if (!clip || !to) return null
  const own = !clip.p2p && clip.author !== null && clip.author.username === me
  const show = fallback === null ? null : (chosen ?? fallback)
  const known = !hosted || located !== undefined
  // Shown names wait for the server's answer; Send waits with them.
  const waiting = show === true && !known
  const shown = show === null ? null : shownSource(clipSourceNames(account, clip), show)
  const retry = () => void locateOnce(account, clip.id).then(retried)
  // A P2P message stored only on two devices: copying it to the instance needs a yes first.
  const go = (showSource: boolean | null) =>
    void compose.forward(showSource).then(
      account.lifetime.inSession(out => {
        if (out) sent?.()
      })
    )
  const send = () =>
    onInstance && clip.p2p
      ? store.getState().askConfirm({
          title: 'Forward',
          body: `This copies the message to ${instance}.`,
          confirm: 'Copy',
          action: () => {
            if (store.getState().forwardClip === clip) go(null)
          },
        })
      : go(show)
  return (
    <ComposerBar
      onClose={clearForward}
      closeLabel="Discard forward"
      actions={
        <>
          {show !== null && (
            <Chip
              title={SHOW_SOURCE}
              onClick={() => setShowSource(draftKey, !show)}
              place="shrink-0"
              as="switch"
              on={show}
              icon={MapPin}
              label={SHOW_SOURCE}
            >
              <span className="@max-sm:hidden">{SHOW_SOURCE}</span>
            </Chip>
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
            <Name
              of={personName(asAccount(clip.author, 'forward'), own)}
              withUsername
              look="font-semibold text-on-surface"
            />
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
              <Name
                of={serverCalled(shown.server, ownSource)}
                look="font-semibold text-on-surface"
              />
              {shown.channel !== null && (
                <>
                  {' > #'}
                  <Covered what="channel" look="font-semibold text-on-surface">
                    <Masked text={shown.channel} own={ownSource} />
                  </Covered>
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

const PILL = sourcePillLook
const PLACE = sourcePlaceLook
const CANT_OPEN = "You can't open this"

function P2pInitial({ name, own }: { name: string; own: boolean }) {
  const mask = useMask(own)
  return <Name of={serverCalled(serverInitial(mask(name)))} />
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
  const label = useNameLabels()
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
        <Name of={serverCalled(server.name, own)} look="min-w-0 truncate" />
      </>
    )
    const channelName = channel && (
      <>
        <Hash size={12} aria-hidden className="shrink-0" />
        <Covered what="channel" look="min-w-0 truncate">
          <Masked text={channel.name} own={own} />
        </Covered>
      </>
    )
    return (
      <div data-forward-pill="open" className={PILL}>
        {head}
        {frame || !openServer ? (
          <span className={`${PLACE} max-w-9/20`}>{serverName}</span>
        ) : (
          <span className="flex max-w-9/20 min-w-0">
            <LinkButton
              title={label.line(
                'Open server',
                () => labelWith`Open ${label(serverCalled(server.name, own))}`
              )}
              onClick={stop(openServer)}
              tone="strong"
            >
              <span className={PLACE}>{serverName}</span>
            </LinkButton>
          </span>
        )}
        {channel && (
          <>
            <ChevronRight size={12} aria-hidden className="shrink-0" />
            {frame || !openOriginal ? (
              <span className={PLACE}>{channelName}</span>
            ) : (
              <LinkButton title={original} onClick={stop(openOriginal)} tone="strong">
                <span className={PLACE}>{channelName}</span>
              </LinkButton>
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
          <LinkButton title={original} onClick={stop(openOriginal)} tone="strong">
            <span className="truncate">a direct message</span>
          </LinkButton>
        ) : (
          <span className="min-w-0 truncate">a direct message</span>
        )}
      </div>
    )
  if (pill.kind === 'named')
    return (
      <div data-forward-pill="named" className={PILL}>
        {head}
        <span className={`${PLACE} max-w-9/20`}>
          <Name of={serverCalled(pill.server)} look="min-w-0 truncate" />
        </span>
        {pill.channel !== null && (
          <>
            <ChevronRight size={12} aria-hidden className="shrink-0" />
            <span className={PLACE}>
              <Hash size={12} aria-hidden className="shrink-0" />
              <Covered what="channel" look="min-w-0 truncate">
                <Masked text={pill.channel} />
              </Covered>
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
    <Row gap="2xs" text="xs" ink="muted" look="italic">
      <Forward size={12} className="shrink-0" />
      Forwarded
    </Row>
  )
  if (blocked && !shown)
    return (
      <Stack gap="2xs" data-forward={fwd.source_id}>
        {head}
        <Surface pad="md" inset="bar" tone="base" radius="lg" border place="max-w-160 min-w-0">
          <BlockedQuote onShow={() => setShown(true)} />
        </Surface>
      </Stack>
    )
  if (!local && access !== 'open')
    return (
      <div data-forward={fwd.source_id} className="min-w-0 text-sm text-on-surface-variant">
        Forwarded message · {target && <RevealChannelPreview target={target} />}{' '}
        <LinkButton
          disabled={sending}
          onClick={() => void openForward(m)}
          tone="inherit"
          underlined
        >
          Open original
        </LinkButton>
      </div>
    )
  return (
    <Stack gap="2xs" data-forward={fwd.source_id}>
      {head}
      <Surface pad="md" inset="bar" tone="base" radius="lg" border place="max-w-160 min-w-0">
        <Row gap="sm" wrap place="min-w-0">
          <Row as="span" gap="sm" place="max-w-full" data-forward-author>
            {author ? (
              <>
                {local ? (
                  <>
                    <span className="block shrink-0 rounded-full">
                      <UserAvatar person={asAccount(author, 'forward')} size={20} />
                    </span>
                    <Name
                      of={personName(asAccount(author, 'forward'))}
                      withUsername
                      place="min-w-0"
                      look="truncate rounded-sm text-sm font-medium"
                    />
                  </>
                ) : (
                  <>
                    <ProfileButton
                      user={author}
                      server={null}
                      focusable={false}
                      shape="round"
                      title="View profile"
                      place="flex shrink-0"
                    >
                      <UserAvatar person={asAccount(author, 'forward')} size={20} />
                    </ProfileButton>
                    <ProfileButton user={author} server={null}>
                      <Name
                        of={personName(asAccount(author, 'forward'))}
                        withUsername
                        link
                        place="min-w-0"
                        look="truncate rounded-sm text-sm font-medium"
                      />
                    </ProfileButton>
                  </>
                )}
                {isWebhookAuthor(author.username) && <WebhookBadge />}
              </>
            ) : (
              <>
                <UserAvatar
                  person={pictured('', { kind: 'color', color: null }, 'unknown')}
                  size={20}
                />
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
          <p className="msg-part text-xs text-on-surface-variant italic">
            File not forwarded: {fwd.dropped}
          </p>
        )}
        {local ? (
          fwd.p2p && <P2pPillOf app={origin.app} pill={origin.pill} place={fwd.p2p} when={when} />
        ) : (
          <HostedSourcePill m={m} when={when} active={!sending} />
        )}
      </Surface>
    </Stack>
  )
}
