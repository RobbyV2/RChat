'use client'

import { Button, IconButton } from './controls'
import { PeerCodeButton } from './p2p/peer_code_button'
import { useActorSuffix, useViewActor } from './view_actor'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ChartColumn,
  Clock,
  Eye,
  EyeOff,
  File as FileIcon,
  Lock,
  Plus,
  Server,
  Share2,
  ShieldAlert,
  X,
} from 'lucide-react'
import { errorText, type UploadMode, useMask, useStore, viewKey } from '../lib/store'
import { limitsOf } from '../lib/instance_limits'
import { guestPostingStatus, postGuest } from '../lib/guest_chat'
import { useAccount } from '../lib/client/react'
import { TextComposer } from './text_composer'
import { outgoing } from '../lib/link_safety'
import { altError, describableFile } from '../lib/alt_text'
import { AltField } from './alt_text'
import { accountPrompt } from '../lib/features'
import { charCount, messageFilterOn } from '../lib/rules'
import { useShownOrNull, useViewServer } from './shown_user'
import { dmPlaceholder } from '../lib/display_name'
import { runJoinStep, type JoinStep } from '../lib/join_flow'
import { hasInviteCode, INVITE_POST_TEXT } from '../lib/p2p/flows'
import { parseSed } from '../lib/sed'
import { useChannelCan } from '../lib/place/use_rights'
import { useHostedServer, useLive } from '../lib/place/react'
import { NO_THREADS_TEXT } from '../lib/channel_perms'
import { textOnlyDestination } from '../lib/channel_content'
import { clock } from '../lib/slowmode'
import { useCountdown } from '../lib/countdown'
import { Dialog, FieldError, fieldCls, Masked, useOwnServer } from './ui'
import { SITE_FILTER_NOTE } from '../lib/home'
import { useUploadHint } from './upload_expiry'
import { useHome } from '../lib/home_store'
import { ReplyBar } from './replies'
import { ForwardBar, useForwardClip } from './forwards'
import { ComposerField } from './composer_field'
import { useCompose } from '../lib/place/use_composer'
import { TimedOutBar, useMyTimeoutEnds } from './timeout_dialog'
import { previewFor } from '../lib/apps/preview'
import { CreatePollDialog } from './poll_dialog'
import type { PollTarget } from '../lib/polls_store'
import { RelayPicker } from './relay_settings'
import type { RelayChoice } from '../lib/relays'
import { useInstanceLabel } from './instance_badge'
import { Dock, Row, Stack, Surface } from './layout'
import { ScheduledChip, SendLaterDialog, useHostedItems, useHostedOps } from './scheduled'
import { laterBlocked, type ComposerDraft } from '../lib/scheduled'

const PRESETS: { label: string; seconds: number | null }[] = [
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '7 days', seconds: 604800 },
  { label: 'Indefinite', seconds: null },
]

const UNITS = [
  { label: 'seconds', mult: 1 },
  { label: 'minutes', mult: 60 },
  { label: 'hours', mult: 3600 },
  { label: 'days', mult: 86400 },
]

const IMG_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' }
export const namePasted = (f: File) =>
  new File([f], `pasted.${IMG_EXT[f.type] ?? f.type.split('/')[1] ?? 'png'}`, { type: f.type })

function ExpiryDialog({
  onPick,
  onClose,
}: {
  onPick: (seconds: number | null, relay: RelayChoice) => void
  onClose: () => void
}) {
  const prefs = useStore(s => s.relayPrefs)
  const [relay, setRelay] = useState<RelayChoice>(prefs.choice)
  const [amount, setAmount] = useState('')
  const [mult, setMult] = useState(3600)
  const custom = Number(amount)
  const customOk = Number.isFinite(custom) && custom > 0
  return (
    <Dialog title="P2P file expiration" onClose={onClose}>
      <Stack gap="lg">
        <Stack gap="md">
          <p className="text-sm text-on-surface-variant">
            Choose how long the P2P files in this message stay stored in your browser. Others can
            only download them while you are online.
          </p>
          <RelayPicker value={relay} onChange={setRelay} prefs={prefs} />
          <Row gap="sm" align="stretch" wrap>
            {PRESETS.map(p => (
              <button
                key={p.label}
                onClick={() => onPick(p.seconds, relay)}
                className="rounded-full border border-outline px-3 py-1.5 text-sm hover:bg-surface-container-highest"
              >
                {p.label}
              </button>
            ))}
          </Row>
        </Stack>
        <Row gap="sm">
          <input
            type="number"
            min={1}
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="Custom"
            className={`${fieldCls} w-24 flex-1`}
          />
          <select value={mult} onChange={e => setMult(Number(e.target.value))} className={fieldCls}>
            {UNITS.map(u => (
              <option key={u.mult} value={u.mult}>
                {u.label}
              </option>
            ))}
          </select>
          <Button
            variant="filled"
            size="md"
            disabled={!customOk}
            onClick={() => onPick(Math.round(custom * mult), relay)}
          >
            Send
          </Button>
        </Row>
      </Stack>
    </Dialog>
  )
}

const NO_SEND = 'You do not have permission to send messages in this channel.'

const useSlowLeft = (channelId: number | null): number =>
  useCountdown(useStore(s => (channelId === null ? 0 : (s.slowUntil[channelId] ?? 0))))

function JoinBar({ server }: { server: string }) {
  const detail = useStore(s => s.servers[server])
  const joinServer = useStore(s => s.joinServer)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<JoinStep>('name')
  const locked = step === 'password'
  const ready = !busy && (!locked || password.trim() !== '')

  const join = async () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    const out = await runJoinStep(step, password, pw => joinServer(server, pw), errorText)
    if (out.done) return
    setStep(out.step)
    setError(out.error)
    setBusy(false)
  }

  return (
    <Dock>
      <Surface data-preview-bar pad="lg" tone="base" radius="xl" border="dashed">
        <Row
          as="form"
          onSubmit={e => {
            e.preventDefault()
            void join()
          }}
          gap="sm"
          wrap
        >
          <Row as="p" gap="sm" place="min-w-0 flex-1">
            <Eye size={16} className="shrink-0 text-primary" />
            <span className="min-w-48 text-sm text-on-surface-variant">
              You&apos;re previewing{' '}
              <span className="streamer font-medium text-on-surface">
                <Masked text={detail?.display_name ?? server} />
              </span>
            </span>
          </Row>
          {locked && (
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Server password"
              className={`${fieldCls} max-w-56`}
            />
          )}
          <Button type="submit" variant="filled" size="md" disabled={!ready}>
            Join server
          </Button>
        </Row>
        <FieldError message={error} />
      </Surface>
    </Dock>
  )
}

// Said once in server channels while the instance filter checks messages, until closed.
function SiteFilterNote() {
  const { home } = useAccount()
  const { label } = useInstanceLabel()
  const on = useStore(s => s.view?.kind === 'channel' && messageFilterOn(s.settings))
  const owner = useHome(s => s.owner)
  const seen = useHome(s => s.prefs.tips.includes(SITE_FILTER_NOTE))
  if (!on || owner === null || seen) return null
  return (
    <p
      data-filter-note
      className="mb-2 flex items-center gap-2 rounded-2xl bg-surface-container px-3 py-1.5 text-xs text-on-surface-variant"
    >
      <ShieldAlert size={14} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="streamer">{label}</span> filters some words in server messages.
      </span>
      <button
        type="button"
        onClick={() => home.hideTip(SITE_FILTER_NOTE)}
        className="shrink-0 cursor-pointer rounded-full px-2 py-0.5 font-medium text-primary hover:bg-surface-container-highest focus-visible:outline-2 focus-visible:outline-primary"
      >
        Got it
      </button>
    </p>
  )
}

const modeTitle = (mode: UploadMode, switchable: boolean, hint: string) => {
  const what =
    mode === 'p2p'
      ? 'P2P: hosted from your browser while you are online, no size limit'
      : `Server: uploaded to the server, ${hint}`
  return switchable ? `${what}. Click for ${mode === 'p2p' ? 'server upload' : 'P2P'}` : what
}

export function MessageComposer({ thread = false }: { thread?: boolean }) {
  const account = useAccount()
  const guest = useStore(s => s.guest)
  const logout = useStore(s => s.logout)
  const ask = useStore(s => accountPrompt(s.settings))
  const view = useStore(s => s.view)
  const servers = useStore(s => s.servers)
  const dms = useStore(s => s.dms)
  const suffix = useActorSuffix(useViewActor())
  const streamer = useStore(s => s.streamer)
  const ownServer = useOwnServer(view?.kind === 'channel' ? view.server : null)
  const uploadHint = useUploadHint(view?.kind === 'channel' ? view.server : null)
  const selfDm = useStore(s => {
    const v = s.view
    return v?.kind === 'dm' && s.dms.some(d => d.id === v.dmId && d.is_self)
  })
  const mask = useMask(ownServer || selfDm)
  const rootId = useStore(s => (s.panel?.kind === 'thread' ? s.panel.root.id : null))
  const member = useStore(s => {
    const v = s.view
    return !s.me || v?.kind !== 'channel' || s.me.servers.some(x => x.name === v.server)
  })
  const draftKey = thread ? (rootId !== null ? `t${rootId}` : null) : view ? viewKey(view) : null
  const textOnly = useStore(s => textOnlyDestination(s, draftKey))
  const held = useStore(s => (draftKey ? s.pending[draftKey] : undefined)) ?? null
  const pending = textOnly ? null : held
  const uploadsOn = useStore(s => s.settings.asset_uploads)
  const p2pOn = useStore(s => s.settings.p2p_attachments)
  const uploadMax = useStore(s => limitsOf(s.instance).upload_bytes)
  const compose = useCompose(thread ? 'thread' : 'main')
  const { text, max, replying } = useLive(compose.state)
  const threadChannel = useStore(s => (s.panel?.kind === 'thread' ? s.panel.root.channel_id : null))
  const placeChannel = thread ? threadChannel : view?.kind === 'channel' ? view.channelId : null
  const can = useChannelCan(
    useHostedServer(view?.kind === 'channel' ? view.server : null),
    placeChannel
  )
  const unstarted = useStore(
    s =>
      thread &&
      s.panel?.kind === 'thread' &&
      s.panel.root.reply_count === 0 &&
      !s.messages[`t${s.panel.root.id}`]?.length
  )
  const canAttach = !textOnly && (uploadsOn || p2pOn) && can.attach
  const uploadFile = useStore(s => s.uploadFile)
  const toggleSpoiler = useStore(s => s.toggleSpoiler)
  const setUploadAlt = useStore(s => s.setUploadAlt)
  const toggleUploadMode = useStore(s => s.toggleUploadMode)
  const sendMessage = useStore(s => s.sendMessage)
  const sendThreadMessage = useStore(s => s.sendThreadMessage)
  const linkPrefs = useStore(s => s.linkPrefs)
  const forwarding = useForwardClip() !== null
  const cancelReply = useStore(s => s.cancelReply)
  const focusAsk = useStore(s => s.composerFocus)
  const sedEdit = useStore(s => s.sedEdit)
  const [expiryOpen, setExpiryOpen] = useState(false)
  const [pollOpen, setPollOpen] = useState(false)
  const [laterOpen, setLaterOpen] = useState(false)
  const scheduledItems = useHostedItems()
  const scheduledOps = useHostedOps()
  const loadScheduled = useStore(s => s.loadScheduled)
  const scheduledHere = useStore(
    s =>
      s.settings.scheduled_messages || !!(s.scheduled.counts?.waiting || s.scheduled.counts?.failed)
  )
  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const focusSeen = useRef(focusAsk?.n ?? 0)
  const channelId = thread ? threadChannel : view?.kind === 'channel' ? view.channelId : null
  const posting = useStore(s =>
    guestPostingStatus(s, view?.kind === 'channel' ? view.server : null, channelId)
  )
  const quote = useStore(s => (draftKey ? s.replying[draftKey]?.message : undefined))
  const shownQuote = useShownOrNull(quote?.author, useViewServer())
  const slowLeft = useSlowLeft(channelId)
  const timedOutEnds = useMyTimeoutEnds(view?.kind === 'channel' ? view.server : null)

  useEffect(() => {
    if (!focusAsk || focusAsk.n === focusSeen.current) return
    focusSeen.current = focusAsk.n
    if (focusAsk.key === draftKey) inputRef.current?.focus()
  }, [focusAsk, draftKey])

  useEffect(() => {
    if (draftKey && scheduledHere) void loadScheduled(draftKey)
  }, [draftKey, scheduledHere, loadScheduled])

  if (!thread && !view) return null

  if (!guest && !member && view?.kind === 'channel') return <JoinBar server={view.server} />

  if (guest) {
    if (posting === 'ready' && view?.kind === 'channel' && channelId !== null && draftKey) {
      return (
        <div
          data-guest-editor
          className="shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] keyboard:pb-3"
        >
          <TextComposer
            key={draftKey}
            inputRef={inputRef}
            label={thread ? 'Reply in thread' : 'Message as a guest'}
            reply={shownQuote?.display_name}
            cancelReply={() => cancelReply(draftKey)}
            send={async content => {
              const message = await account.lifetime.live(
                postGuest(account.api, view.server, `/channels/${channelId}/guest-messages`, {
                  content: outgoing(linkPrefs, content),
                  reply_to: quote?.id,
                  thread_root_id: thread && rootId !== null ? rootId : undefined,
                })
              )
              account.store.getState().applyWsEvent({
                type: 'message',
                server: view.server,
                channel_id: channelId,
                dm_id: null,
                dm_users: null,
                message,
              })
              cancelReply(draftKey)
            }}
          />
        </div>
      )
    }
    return (
      <Dock>
        <Surface data-guest-notice pad="lg" tone="base" radius="xl">
          <p className="text-sm text-on-surface-variant">
            {
              {
                off: 'Guest posting is off here.',
                checking: 'Checking guest access…',
                paused: 'Guest posting is paused by a moderator.',
                unavailable: 'Guest posting is unavailable here.',
                ready: '',
              }[posting]
            }{' '}
            <Link href="/login" onClick={() => logout()} className="text-primary underline">
              {ask}
            </Link>{' '}
            to use account features.
          </p>
        </Surface>
      </Dock>
    )
  }

  if (view?.kind === 'channel' && timedOutEnds !== null) return <TimedOutBar ends={timedOutEnds} />

  if (view?.kind === 'channel' && (!can.send || (unstarted && !can.threads))) {
    return (
      <Dock>
        <Surface data-no-send row pad="lg" gap="sm" tone="base" radius="xl">
          <Lock size={16} className="shrink-0 text-on-surface-variant" />
          <span className="text-sm text-on-surface-variant">
            {can.send ? NO_THREADS_TEXT : NO_SEND}
          </span>
        </Surface>
      </Dock>
    )
  }

  const placeholder = thread
    ? 'Message thread'
    : view?.kind === 'channel'
      ? `Message #${mask(servers[view.server]?.channels.find(c => c.id === view.channelId)?.name ?? '')}`
      : dmPlaceholder(dms.find(d => d.id === view?.dmId)?.other, streamer, mask)

  const { setText } = compose
  const draftNow = compose.getText

  const pollTarget: PollTarget | null =
    textOnly || !can.polls
      ? null
      : thread
        ? rootId !== null
          ? { kind: 'thread', id: rootId }
          : null
        : view?.kind === 'channel'
          ? { kind: 'channel', id: view.channelId }
          : view?.kind === 'dm'
            ? { kind: 'dm', id: view.dmId }
            : null

  const switchable = pending !== null && uploadsOn && p2pOn && pending.file.size <= uploadMax

  const attach = (file: File | null) => {
    if (draftKey) uploadFile(draftKey, file)
  }

  const count = charCount(text)
  const tooLong = count > max

  const closeBar = replying && draftKey ? () => cancelReply(draftKey) : null
  const bar =
    closeBar && draftKey ? (
      <ReplyBar draftKey={draftKey} onClose={closeBar} />
    ) : forwarding && draftKey ? (
      <ForwardBar draftKey={draftKey} />
    ) : null

  const doSend = (p2pExpiresIn?: number | null, relay?: RelayChoice) => {
    const sent = outgoing(linkPrefs, text)
    void (thread
      ? sendThreadMessage(sent, p2pExpiresIn, relay)
      : sendMessage(sent, p2pExpiresIn, relay))
    setText('')
  }

  // Schedules the draft as written, after the invite code question when it has one.
  const scheduleAt = async (at: number): Promise<string | null> => {
    if (!draftKey) return null
    const key = draftKey
    const st = account.store.getState()
    const go = () =>
      void st
        .scheduleDraft(key, at, t => outgoing(linkPrefs, t))
        .then(e => {
          if (e) account.store.getState().showToast(e)
        })
    if (hasInviteCode(draftNow())) {
      st.askConfirm({
        title: 'Post Invite Code',
        body: INVITE_POST_TEXT,
        confirm: 'Schedule',
        action: account.lifetime.inSession(go),
      })
      return null
    }
    return st.scheduleDraft(key, at, t => outgoing(linkPrefs, t))
  }

  // The draft as Send later reads it when a menu row runs.
  const laterDraft = (): ComposerDraft | null => {
    if (!draftKey) return null
    const st = account.store.getState()
    const body = st.drafts[draftKey] ?? ''
    const reply = st.replying[draftKey]
    return {
      side: 'hosted',
      place: draftKey,
      text: body,
      reply: reply ? { id: String(reply.message.id), mention: reply.mention } : null,
      blocked: laterBlocked({
        text: body,
        rich: !!st.pending[draftKey] || st.forwardClip !== null || pollOpen,
        tooLong: charCount(body) > limitsOf(st.instance).message_chars,
        on: st.settings.scheduled_messages,
        cap: limitsOf(st.instance).scheduled_per_account,
        waiting: st.scheduled.counts?.waiting ?? 0,
      }),
      schedule: async at => {
        await scheduleAt(at)
      },
      pick: () => setLaterOpen(true),
    }
  }

  const send = () => {
    if ((!text.trim() && !pending) || tooLong || altError(pending?.alt ?? '')) return
    const sed = pending || !draftKey ? null : parseSed(text)
    if (sed && draftKey) {
      void sedEdit(draftKey, sed).then(
        account.lifetime.inSession(ok => {
          if (ok && draftNow() === text) setText('')
        })
      )
      return
    }
    if (
      !thread &&
      !pending &&
      !replying &&
      !forwarding &&
      view?.kind === 'channel' &&
      previewFor(account).dispatchPreviewText(text)
    ) {
      setText('')
      return
    }
    if (slowLeft > 0) return
    const go = () => (pending?.mode === 'p2p' ? setExpiryOpen(true) : doSend())
    // A P2P server invite code posted here can be read by the instance.
    if (hasInviteCode(text))
      return account.store.getState().askConfirm({
        title: 'Post Invite Code',
        body: INVITE_POST_TEXT,
        confirm: 'Post',
        action: account.lifetime.inSession(go),
      })
    go()
  }

  return (
    <div className="shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] keyboard:pb-3">
      <PeerCodeButton text={text} />
      {pollOpen && pollTarget && (
        <CreatePollDialog target={pollTarget} onClose={() => setPollOpen(false)} />
      )}
      {laterOpen && (
        <SendLaterDialog
          side="hosted"
          onClose={() => setLaterOpen(false)}
          onPick={async at => {
            const e = await scheduleAt(at)
            if (!e) setLaterOpen(false)
            return e
          }}
        />
      )}
      {expiryOpen && !textOnly && (
        <ExpiryDialog
          onPick={(seconds, relay) => {
            setExpiryOpen(false)
            doSend(seconds, relay)
          }}
          onClose={() => setExpiryOpen(false)}
        />
      )}
      {pending && (
        <div className="relative mb-2 flex h-24 w-48 flex-col justify-between rounded-xl border border-outline-variant bg-surface-container p-3">
          <button
            title="Remove file"
            onClick={() => attach(null)}
            className="absolute -top-2 -right-2 rounded-full bg-error-container p-1 text-on-error-container shadow-elevation-1"
          >
            <X size={12} />
          </button>
          <div className="flex items-center justify-between">
            <FileIcon size={20} className="text-primary" />
            <Row gap="2xs">
              <button
                title={modeTitle(pending.mode, switchable, uploadHint)}
                onClick={() => draftKey && toggleUploadMode(draftKey)}
                disabled={!switchable}
                className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium disabled:cursor-default ${
                  pending.mode === 'p2p'
                    ? 'bg-tertiary-container text-on-tertiary-container'
                    : 'bg-surface-container-highest text-on-surface-variant'
                }`}
              >
                {pending.mode === 'p2p' ? <Share2 size={12} /> : <Server size={12} />}
                {pending.mode === 'p2p' ? 'P2P' : 'Server'}
              </button>
              <button
                title={pending.spoiler ? 'Unmark spoiler' : 'Mark as spoiler'}
                onClick={() => draftKey && toggleSpoiler(draftKey)}
                className={`rounded-full p-1 ${
                  pending.spoiler
                    ? 'bg-primary-container text-on-primary-container'
                    : 'text-on-surface-variant hover:bg-surface-container-high'
                }`}
              >
                {pending.spoiler ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </Row>
          </div>
          <span className="truncate text-xs">
            {pending.spoiler ? 'Spoiler · ' : ''}
            {pending.file.name}
          </span>
        </div>
      )}
      {pending && describableFile(pending.file.name, pending.file.type) && (
        <div data-alt-field className="mb-2 w-72 max-w-full">
          <AltField
            value={pending.alt ?? ''}
            onChange={v => draftKey && setUploadAlt(draftKey, v)}
          />
        </div>
      )}
      {slowLeft > 0 && (
        <p
          role="status"
          className="mb-1 flex items-center justify-end gap-1 px-3 text-xs text-on-surface-variant tabular-nums"
        >
          <Clock size={12} className="shrink-0" />
          Slow mode: {clock(slowLeft)}
        </p>
      )}
      {draftKey && <ScheduledChip place={draftKey} items={scheduledItems} ops={scheduledOps} />}
      {!thread && <SiteFilterNote />}
      <ComposerField
        compose={compose}
        listKey={draftKey}
        placeholder={placeholder + suffix}
        slowLeft={slowLeft}
        mayEditLast={can.send}
        bar={bar}
        inputRef={inputRef}
        later={laterDraft}
        onSend={send}
        onPaste={e => {
          if (!canAttach) return false
          const file = Array.from(e.clipboardData.items)
            .find(i => i.kind === 'file' && i.type.startsWith('image/'))
            ?.getAsFile()
          if (file) attach(namePasted(file))
          return !!file
        }}
        tools={
          <>
            {canAttach && (
              <>
                <IconButton
                  icon={Plus}
                  label="Attach a file"
                  place="pointer-coarse:-mx-1.5"
                  onClick={() => fileRef.current?.click()}
                />
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  onChange={e => {
                    attach(e.target.files?.item(0) ?? null)
                    e.target.value = ''
                  }}
                />
              </>
            )}
            {pollTarget && (
              <IconButton
                icon={ChartColumn}
                label="Create poll"
                place="pointer-coarse:-mx-1.5"
                data-create-poll
                onClick={() => setPollOpen(true)}
              />
            )}
          </>
        }
      />
    </div>
  )
}
