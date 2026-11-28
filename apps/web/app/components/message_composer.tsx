'use client'
import { OwnLoadNotice } from './own_load'

import { Name } from './name'
import { instanceName } from '../lib/names'
import { Button, IconButton } from './controls'
import { PeerCodeButton } from './p2p/peer_code_button'
import { useActorSuffix, useViewActor } from './view_actor'
import { useEffect, useState } from 'react'
import { ChartColumn, Clock, ShieldAlert } from 'lucide-react'
import { useMask, useStore, viewKey } from '../lib/store'
import { limitsOf } from '../lib/instance_limits'
import { useAccount } from '../lib/client/react'
import { outgoing } from '../lib/link_safety'
import { altError } from '../lib/alt_text'
import { charCount, messageFilterOn } from '../lib/rules'
import { dmPlaceholder } from '../lib/display_name'
import { hasInviteCode, INVITE_POST_TEXT } from '../lib/p2p/flows'
import { parseSed } from '../lib/sed'
import { useChannelCan } from '../lib/place/use_rights'
import { useHostedServer, useLive } from '../lib/place/react'
import { textOnlyDestination } from '../lib/channel_content'
import { clock } from '../lib/slowmode'
import { useCountdown } from '../lib/countdown'
import { Dialog, fieldCls, useOwnServer } from './ui'
import { SITE_FILTER_NOTE } from '../lib/home'
import { useHome } from '../lib/home_store'
import { ReplyBar } from './replies'
import { ComposerGate, useGate } from './composer_gate'
import { ForwardBar, useForwardClip } from './forwards'
import { ComposerField } from './composer_field'
import { AttachButton, ComposerFiles, pastedFiles } from './composer_files'
import { useCompose } from '../lib/place/use_composer'
import { previewFor } from '../lib/apps/preview'
import { CreatePollDialog } from './poll_dialog'
import type { PollTarget } from '../lib/polls_store'
import { RelayPicker } from './relay_settings'
import type { RelayChoice } from '../lib/relays'
import { useInstanceLabel } from './instance_badge'
import { Dock, Row, Stack, Surface, Inset } from './layout'
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
              <Button key={p.label} variant="tonal" onClick={() => onPick(p.seconds, relay)}>
                {p.label}
              </Button>
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

const useSlowLeft = (channelId: number | null): number =>
  useCountdown(useStore(s => (channelId === null ? 0 : (s.slowUntil[channelId] ?? 0))))

// Said once in server channels while the instance filter checks messages, until closed.
function SiteFilterNote() {
  const { home } = useAccount()
  const { label } = useInstanceLabel()
  const on = useStore(s => s.view?.kind === 'channel' && messageFilterOn(s.settings))
  const owner = useHome(s => s.owner)
  const seen = useHome(s => s.prefs.tips.includes(SITE_FILTER_NOTE))
  if (!on || owner === null || seen) return null
  return (
    <Surface
      data-filter-note
      as="p"
      row
      pad="md"
      inset="chip"
      gap="sm"
      tone="base"
      text="xs"
      ink="muted"
    >
      <ShieldAlert size={14} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <Name of={instanceName(label)} /> filters some words in server messages.
      </span>
      <Button onClick={() => home.hideTip(SITE_FILTER_NOTE)} place="shrink-0">
        Got it
      </Button>
    </Surface>
  )
}

export function MessageComposer({ thread = false }: { thread?: boolean }) {
  const account = useAccount()
  const view = useStore(s => s.view)
  const servers = useStore(s => s.servers)
  const dms = useStore(s => s.dms)
  const suffix = useActorSuffix(useViewActor())
  const streamer = useStore(s => s.streamer)
  const ownServer = useOwnServer(view?.kind === 'channel' ? view.server : null)
  const selfDm = useStore(s => {
    const v = s.view
    return v?.kind === 'dm' && s.dms.some(d => d.id === v.dmId && d.is_self)
  })
  const mask = useMask(ownServer || selfDm)
  const rootId = useStore(s => (s.panel?.kind === 'thread' ? s.panel.root.id : null))
  const draftKey = thread ? (rootId !== null ? `t${rootId}` : null) : view ? viewKey(view) : null
  const textOnly = useStore(s => textOnlyDestination(s, draftKey))
  const held = useStore(s => (draftKey ? s.pending[draftKey] : undefined)) ?? null
  const pending = textOnly ? null : held
  const compose = useCompose(thread ? 'thread' : 'main')
  const { text, max, replying } = useLive(compose.state)
  const { shut } = useGate(compose)
  const threadChannel = useStore(s => (s.panel?.kind === 'thread' ? s.panel.root.channel_id : null))
  const placeChannel = thread ? threadChannel : view?.kind === 'channel' ? view.channelId : null
  const can = useChannelCan(
    useHostedServer(view?.kind === 'channel' ? view.server : null),
    placeChannel
  )
  const sendMessage = useStore(s => s.sendMessage)
  const sendThreadMessage = useStore(s => s.sendThreadMessage)
  const linkPrefs = useStore(s => s.linkPrefs)
  const forwarding = useForwardClip() !== null
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
  const channelId = thread ? threadChannel : view?.kind === 'channel' ? view.channelId : null
  const slowLeft = useSlowLeft(channelId)

  useEffect(() => {
    if (draftKey && scheduledHere) void loadScheduled(draftKey)
  }, [draftKey, scheduledHere, loadScheduled])

  if (!thread && !view) return null

  if (shut) return <ComposerGate compose={compose} list={thread ? 'thread' : 'main'} />

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

  const count = charCount(text)
  const tooLong = count > max

  const bar =
    replying && draftKey ? (
      <ReplyBar list={thread ? 'thread' : 'main'} />
    ) : forwarding && draftKey ? (
      <ForwardBar list={thread ? 'thread' : 'main'} />
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
    <Dock gap="sm">
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
      <ComposerFiles compose={compose} />
      {slowLeft > 0 && (
        <Inset
          role="status"
          as="p"
          row
          pad="md"
          inset="sides"
          gap="2xs"
          justify="end"
          text="xs"
          ink="muted"
          look="tabular-nums"
        >
          <Clock size={12} className="shrink-0" />
          Slow mode: {clock(slowLeft)}
        </Inset>
      )}
      {draftKey && (
        <OwnLoadNotice
          what={`scheduled:${draftKey}`}
          lead="Could not load the messages scheduled here."
          retry={() => void loadScheduled(draftKey)}
        />
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
        later={laterDraft}
        onSend={send}
        onPaste={e => compose.paste(pastedFiles(e))}
        tools={
          <>
            <AttachButton compose={compose} />
            {pollTarget && (
              <IconButton
                icon={ChartColumn}
                label="Create poll"
                tight
                data-create-poll
                onClick={() => setPollOpen(true)}
              />
            )}
          </>
        }
      />
    </Dock>
  )
}
