'use client'
import { useAccount } from '../lib/client/react'
import { useContext, useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react'
import { Reply } from 'lucide-react'
import { openActionMenu } from '../lib/actions/menu'
import { defineAction } from '../lib/actions/registry'
import { messagePlaces, type GroupPlace } from '../lib/message_groups'
import { isNotice } from '../lib/system_messages'
import { groupPadCls, gutterTimeCls } from '../components/grouped_row'
import { WidgetForwardAccess, WidgetLinkCards } from '../components/message_link_card'
import { WidgetNotice } from '../components/widget_notice'
import { RevealChannelPreview } from '../components/preview_reveal'
import { frameCopyTarget } from '../lib/forward_viewing'
import { SpoilerLine } from '../components/replies'
import { snippetParts } from '../lib/replies'
import { plainStamps } from '../lib/timestamps'
import { ShortTime } from '../components/timestamp'
import { MarkdownMessage } from '../components/markdown_message'
import { ContextMenu, longPress } from '../components/context_menu'
import { TextComposer } from '../components/text_composer'
import { UserAvatar } from '../components/user_avatar'
import { fieldCls, filledBtn, Masked, textBtn } from '../components/ui'
import { audibleStreams, guestLabel, isGuestName } from '../lib/guest_voice'
import { restoreStreamer } from '../lib/start'
import { errorText } from '../lib/store'
import { WidgetConnection } from '../lib/widget_connection'
import { ViewingPrompt } from '../components/viewing_prompt'
import {
  canView,
  cancelViewing,
  channelTarget,
  forgetViewing,
  leaveVisit,
  markPersonally,
  personallyMarked,
  needsWarning,
  requestViewing,
  useViewing,
} from '../lib/viewing'
import type { WidgetRoomMetadata } from '../lib/widgets'
import type { ForwardRef, Message } from '../lib/types'

function Audio({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.srcObject = stream
    void el.play().catch(() => {})
    return () => {
      el.srcObject = null
    }
  }, [stream])
  return <audio ref={ref} autoPlay />
}

function AccessForm({ client }: { client: WidgetConnection }) {
  const [choice, setChoice] = useState<'account' | 'grant' | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    setError('')
    try {
      const password = String(form.get('password') ?? '')
      if (choice === 'account') await client.login(String(form.get('username') ?? ''), password)
      else await client.unlock(password)
      setChoice(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="min-w-0 px-2 py-1">
      <div className="flex flex-wrap gap-1">
        {client.signedIn ? (
          <button className={textBtn + ' cursor-pointer'} onClick={() => client.logout()}>
            Sign out
          </button>
        ) : (
          <button
            className={textBtn + ' cursor-pointer'}
            onClick={() => setChoice(choice === 'account' ? null : 'account')}
          >
            Sign in
          </button>
        )}
        {client.mode === 'voice' && !client.room && !client.signedIn && (
          <button
            className={textBtn + ' cursor-pointer'}
            onClick={() => setChoice(choice === 'grant' ? null : 'grant')}
          >
            Use server password
          </button>
        )}
      </div>
      {choice && (
        <form onSubmit={submit} className="grid gap-2 py-1">
          {choice === 'account' && (
            <input
              className={fieldCls}
              name="username"
              autoComplete="username"
              aria-label="Username"
              placeholder="Username"
              required
            />
          )}
          <input
            className={fieldCls}
            name="password"
            type="password"
            autoComplete={choice === 'account' ? 'current-password' : 'off'}
            aria-label="Password"
            placeholder="Password"
            required
          />
          <button className={filledBtn + ' cursor-pointer'} disabled={busy}>
            {choice === 'account' ? 'Sign in to widget' : 'Open room'}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
    </div>
  )
}
function ChatRow({
  message,
  place,
  client,
  reply,
}: {
  message: Message
  place: GroupPlace
  client: WidgetConnection
  reply: (message: Message) => void
}) {
  const acct = useAccount()

  const sender = 'widget-author-' + message.id,
    time = 'widget-time-' + message.id
  const date = new Date(message.created_at * 1000)
  const canReply = client.canPost && message.kind === 'user'
  const forwardAccess = useContext(WidgetForwardAccess)
  const quoted = message.reply_to?.forward ? forwardAccess(message.reply_to.forward) : null
  const body = message.forward ? forwardAccess(message.forward) : null
  const owner = 'widget-message-' + message.id
  useEffect(() => {
    return () => {
      const state = acct.store.getState()
      if (state.contextMenu?.owner === owner) state.closeContextMenu()
    }
  }, [acct, canReply, owner])
  const pick = () => {
    const target = client.replyTarget(message.id)
    if (target) reply(target)
  }
  const open = (x: number, y: number) =>
    openActionMenu(
      x,
      y,
      {
        kind: 'widget_message',
        canReply: () => !!client.replyTarget(message.id),
        reply: pick,
      },
      { owner },
      acct
    )
  if (isNotice(message)) return <WidgetNotice message={message} />
  return (
    <article
      {...(canReply ? longPress(open) : {})}
      data-mid={message.id}
      aria-labelledby={sender + ' ' + time}
      tabIndex={!place.first && !canReply ? 0 : undefined}
      className={
        'group grid min-w-0 grid-cols-[36px_minmax(0,1fr)_auto] items-start gap-x-3 break-words rounded px-1 hover:bg-surface-container-low ' +
        groupPadCls(place.first, place.last)
      }
    >
      {place.first ? (
        <div aria-hidden="true" data-author-avatar className="col-start-1 row-start-1 pt-0.5">
          <UserAvatar
            username={message.author.username}
            avatarKind={message.author.avatar_kind}
            avatarColor={message.author.avatar_color}
            size={36}
          />
        </div>
      ) : (
        <div aria-hidden="true" data-group-time className="relative col-start-1 row-start-1">
          <ShortTime
            ts={message.created_at}
            className={
              gutterTimeCls +
              ' group-focus-visible:opacity-100 group-has-[:focus-visible]:opacity-100'
            }
          />
        </div>
      )}
      <div className="col-start-2 row-start-1 min-w-0">
        <div
          data-group-header={place.first ? '' : undefined}
          className={place.first ? 'flex flex-wrap items-baseline gap-x-2' : 'sr-only'}
        >
          <strong id={sender} className="streamer min-w-0 max-w-full truncate text-sm">
            <Masked
              text={message.author.display_name}
              own={message.author.username === client.account}
            />
          </strong>
          <time
            id={time}
            className="text-xs text-on-surface-variant"
            dateTime={date.toISOString()}
            title={date.toLocaleString()}
          >
            {date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
          </time>
        </div>
        {message.reply_to && (
          <div className="min-w-0 border-l-2 border-outline pl-2 text-xs break-words">
            {message.reply_to.author && (
              <>
                <span className="streamer">
                  <Masked
                    text={message.reply_to.author.display_name}
                    own={message.reply_to.author.username === client.account}
                  />
                </span>{' '}
                ·{' '}
              </>
            )}
            {message.reply_to.deleted ? (
              'Original message was deleted'
            ) : quoted && !quoted.open ? (
              <>
                <span className="italic">Forwarded message</span>{' '}
                {quoted.target && <RevealChannelPreview target={quoted.target} />}
              </>
            ) : message.reply_to.content ? (
              <SpoilerLine
                key={JSON.stringify([client.account, message.reply_to.id])}
                parts={snippetParts(plainStamps(message.reply_to.content))}
                own={
                  !message.reply_to.forwarded &&
                  message.reply_to.author?.username === client.account
                }
              />
            ) : message.reply_to.has_media ? (
              'Attachment'
            ) : (
              'Reply'
            )}
          </div>
        )}
        {body && !body.open ? (
          <p className="text-sm text-on-surface-variant">
            <span className="italic">Forwarded message</span>{' '}
            {body.target && <RevealChannelPreview target={body.target} />}
          </p>
        ) : (
          <MarkdownMessage message={message} />
        )}
      </div>
      {canReply && (
        <button
          type="button"
          aria-label="Reply"
          title="Reply"
          className="col-start-3 row-start-1 cursor-pointer rounded px-1 text-primary pointer-fine:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
          onClick={pick}
        >
          <Reply size={16} />
        </button>
      )}
    </article>
  )
}

function WidgetChat({ client, rows }: { client: WidgetConnection; rows: Message[] }) {
  const [reply, setReply] = useState<Message | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const draft = client.draft
  const groups = useMemo(() => messagePlaces(rows), [rows])
  const last = rows.at(-1)?.id
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' })
  }, [last])
  return (
    <>
      <div className="min-h-16 min-w-0 flex-1 overflow-auto p-3" aria-label="Messages">
        <WidgetForwardAccess.Provider value={fwd => copyAccess(fwd, client)}>
          <WidgetLinkCards.Provider value={client.linkCards}>
            {rows.map((message, i) => (
              <ChatRow
                key={message.id}
                message={message}
                place={groups[i]}
                client={client}
                reply={setReply}
              />
            ))}
          </WidgetLinkCards.Provider>
        </WidgetForwardAccess.Provider>
        <div ref={bottom} />
      </div>
      {client.canRestoreDraft ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1 p-2 text-sm">
          <p className="w-full">
            {client.draftExpired ? 'Your sign-in expired.' : 'Your sign-in changed.'} Your unsent
            text is still here.
          </p>
          <button
            type="button"
            className={textBtn + ' cursor-pointer'}
            onClick={() => client.recoverDraft(true)}
          >
            Restore draft
          </button>
          <button
            type="button"
            className={textBtn + ' cursor-pointer'}
            onClick={() => client.recoverDraft(false)}
          >
            Discard draft
          </button>
        </div>
      ) : client.canPost ? (
        <TextComposer
          initialText={draft.text}
          onTextChange={value => {
            draft.text = value
          }}
          label={client.signedIn ? 'Message' : 'Message as a guest'}
          reply={reply?.author.display_name}
          cancelReply={() => setReply(null)}
          send={async text => {
            await client.send(text, reply?.id)
            setReply(null)
          }}
        />
      ) : (
        <p className="p-3 text-sm text-on-surface-variant">
          {client.heldNotice ?? 'Read-only chat'}
        </p>
      )}
    </>
  )
}

// The frame serves this origin even when the main app has selected another instance.
const frameInstance = () => ({ origin: location.origin, scoped: (key: string) => key })
const viewingTarget = (metadata: WidgetRoomMetadata, account: string | null) =>
  channelTarget(
    account,
    'instance',
    metadata.server,
    { id: metadata.channel_id, sensitive: metadata.sensitive },
    frameInstance()
  )

const copyAccess = (fwd: ForwardRef, client: WidgetConnection) => {
  const target = client.metadata
    ? frameCopyTarget(fwd, client.metadata, client.account, frameInstance())
    : null
  return { open: !!client.metadata && (!target || canView(target)), target }
}

export default function WidgetPage() {
  const [, redraw] = useReducer(n => n + 1, 0)
  const [client, setClient] = useState<WidgetConnection | null>(null)
  const prompted = useRef('')
  const revision = useViewing(s => s.revision)
  useEffect(
    () =>
      defineAction({
        id: 'widget_reply',
        title: 'Reply',
        icon: Reply,
        scope: 'message',
        targets: ['widget_message'],
        available: ({ target }) => target.kind === 'widget_message' && target.canReply(),
        run: ({ target }) => {
          if (target.kind === 'widget_message') target.reply()
        },
      }),
    []
  )
  useEffect(() => {
    const preview = window.frameElement
    if (!preview?.hasAttribute('data-preview-streamer')) {
      restoreStreamer()
      return
    }
    const sync = () =>
      document.body.classList.toggle(
        'streamer-mode',
        preview.getAttribute('data-preview-streamer') === 'on'
      )
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(preview, { attributes: true, attributeFilter: ['data-preview-streamer'] })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const args = new URLSearchParams(location.search)
    const theme = args.get('theme')
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
    const connection = new WidgetConnection(args.get('id') ?? '', redraw, (room, account) =>
      canView(viewingTarget(room, account))
    )
    const unsubscribe = useViewing.subscribe((next, prior) => {
      if (next.revision !== prior.revision) connection.updateViewing()
    })
    setClient(connection)
    void connection.start()
    const end = () => {
      unsubscribe()
      connection.destroy()
      cancelViewing()
      leaveVisit()
    }
    window.addEventListener('storage', connection.syncLogin)
    window.addEventListener('pagehide', end)
    return () => {
      window.removeEventListener('storage', connection.syncLogin)
      window.removeEventListener('pagehide', end)
      end()
    }
  }, [])
  const metadata = client?.metadata
  const account = client?.account ?? null
  const target = useMemo(
    () => (metadata ? viewingTarget(metadata, account) : null),
    [metadata, account]
  )
  const gated = target !== null && !canView(target)
  // One-time openings end with the frame's identity; a revealed source room stays open with it.
  const roomKey = target?.key
  useEffect(() => leaveVisit(roomKey), [roomKey])
  useEffect(() => {
    if (!target) {
      prompted.current = ''
      cancelViewing()
    } else if (gated && prompted.current !== target.key) {
      prompted.current = target.key
      void requestViewing(target)
    }
  }, [target, gated, revision])
  const room = gated ? null : client?.room
  return (
    <main
      className="flex h-dvh min-w-0 flex-col overflow-y-auto bg-surface text-on-surface"
      aria-label="Channel widget"
    >
      {room && client ? (
        <>
          <header className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-b border-outline-variant px-3 py-2">
            <h1 className="min-w-0 break-words font-medium">
              {room.kind === 'text' ? '# ' : ''}
              {room.name}
            </h1>
            {client.mode !== 'read_link' && client.mode !== 'public_read' && (
              <AccessForm client={client} />
            )}
          </header>
          {room.kind === 'text' ? (
            <WidgetChat key={target?.key} client={client} rows={room.messages} />
          ) : (
            <section className="min-h-0 flex-1 space-y-3 overflow-auto p-3" aria-label="Voice room">
              <h2 className="text-sm font-medium">In voice</h2>
              <ul className="space-y-1">
                {room.users.map(u => (
                  <li key={u} className="streamer break-words">
                    {isGuestName(u) ? guestLabel(u) : u}
                    {u === client.name ? ' (you)' : ''}
                    {client.statusOf(u).map(text => ` · ${text}`)}
                  </li>
                ))}
              </ul>
              {client.inVoice ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    className={filledBtn + ' cursor-pointer'}
                    disabled={client.silenced.includes(client.name)}
                    onClick={() => client.mute()}
                  >
                    {client.userMuted ? 'Unmute' : 'Mute'}
                  </button>
                  <button className={textBtn + ' cursor-pointer'} onClick={() => client.leave()}>
                    Leave voice
                  </button>
                </div>
              ) : room.participate && !client.hideSend ? (
                <button
                  className={filledBtn + ' cursor-pointer'}
                  disabled={!client.name || client.joining}
                  onClick={() => void client.join()}
                >
                  {client.joining ? 'Joining…' : 'Join voice'}
                </button>
              ) : (
                <p className="text-sm text-on-surface-variant">
                  Voice participation is unavailable.
                </p>
              )}
              {audibleStreams(client.rtc.remoteStreams(), client.silenced, false).map(a => (
                <Audio key={a.key} stream={a.stream} />
              ))}
            </section>
          )}
        </>
      ) : gated && target ? (
        <div className="p-3">
          <p role="status">This channel is marked sensitive.</p>
          <button
            className={textBtn + ' cursor-pointer'}
            onClick={() => void requestViewing(target)}
          >
            Open channel
          </button>
          {client && client.mode !== 'public_read' && client.mode !== 'read_link' && (
            <AccessForm client={client} />
          )}
        </div>
      ) : (
        <div className="p-3">
          <p role="status">
            {client?.loaded
              ? (client.heldNotice ?? 'This widget is unavailable.')
              : 'Opening channel…'}
          </p>
          {client?.mode && ['members', 'voice', 'public_chat'].includes(client.mode) && (
            <AccessForm client={client} />
          )}
        </div>
      )}
      {client?.error && room && (
        <p role="alert" className="shrink-0 px-3 py-1 text-sm text-error">
          {client.error}
        </p>
      )}
      {client && !client.storage && (
        <p className="shrink-0 px-3 py-1 text-xs text-on-surface-variant">
          This frame can remember you only while it is open.
        </p>
      )}
      {target && (
        <details className="shrink-0 border-t border-outline-variant px-3 py-1 text-xs">
          <summary className="w-fit cursor-pointer py-1 text-on-surface-variant">
            Viewing options
          </summary>
          <label className="flex min-h-8 w-fit cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="cursor-pointer"
              checked={personallyMarked(target)}
              onChange={e => {
                prompted.current = target.key
                markPersonally(target, e.target.checked)
              }}
            />
            Mark sensitive on this device
          </label>
          {room && needsWarning(target) && (
            <button
              className={textBtn + ' cursor-pointer'}
              onClick={() => {
                prompted.current = target.key
                forgetViewing(target)
              }}
            >
              Hide channel
            </button>
          )}
        </details>
      )}
      <ContextMenu />
      <ViewingPrompt />
    </main>
  )
}
