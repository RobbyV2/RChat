'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useMask, useStore } from '../../lib/store'
import {
  memberName,
  p2pDm,
  p2pThread,
  threadKey,
  threadScope,
  useP2p,
  type P2pThread,
} from '../../lib/p2p/app'
import type { P2pMessage } from '../../lib/p2p/dm'
import { P } from '../../lib/p2p/state'
import type { ServerView } from '../../lib/p2p/server'
import { newSince } from '../../lib/lists'
import type { Message } from '../../lib/types'
import { ChatSourceProvider } from '../chat_source'
import { EmojiPicker } from '../emoji_picker'
import { ThreadPanelView } from '../thread_panel'
import { TypingIndicator } from '../typing_indicator'
import { PresentBar, useChatScroll } from '../viewport_height'
import { textBtn, useEscape } from '../ui'
import { P2pComposer, P2pRow, pingsMe, useP2pFlash, useP2pList, type Mentionable } from './p2p_chat'
import { sendBlock } from './p2p_server_view'

// The thread of a P2P server channel beside it (full screen on phones): its root, the replies
// stored here and a composer, through the same panel as instance threads.

const EMPTY: P2pMessage[] = []
const NONE: string[] = []

export function P2pThreadPanel() {
  const t = useP2p(s => s.thread)
  const v = useP2p(s => (s.thread ? s.servers[s.thread.room] : undefined))
  if (!t || !v) return null
  return <ThreadBody key={`${t.room}/${t.root}`} t={t} v={v} />
}

function ThreadBody({ t, v }: { t: P2pThread; v: ServerView }) {
  const me = useP2p(s => s.me)
  const reader = useP2p(s => s.reader)
  const elsewhere = useP2p(s => s.elsewhere)
  const status = useP2p(s => s.status)
  const movedAt = useP2p(s => s.movedAt)
  const movingAt = useP2p(s => s.movingAt)
  const key = threadKey(t)
  const scope = threadScope(t)
  const focus = useP2p(s => (s.focus?.room === key ? s.focus : null))
  const typers = useP2p(s => s.serverTyping[key] ?? NONE)
  const unseen = (v.chans[t.ch]?.threads?.[t.root] ?? 0) > 0
  const following = useStore(s => s.atBottom[scope] === true)
  const mask = useMask()
  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const room = v.id
  const nameOf = useCallback((ik: string) => mask(memberName(room, ik)), [room, mask])
  const members = v.members
  const people = useMemo<Mentionable[]>(
    () =>
      members.filter(m => m.m === 'join').map(m => ({ ik: m.ik, name: m.name, handle: m.name })),
    [members]
  )
  const moderator = v.me === 'join' && (v.perms & P.ManageMessages) !== 0
  const mayDelete = useCallback((p: P2pMessage) => p.sender === me || moderator, [me, moderator])
  const disabled = sendBlock(v, { reader, elsewhere, status, movedAt, movingAt })
  const canAct = !disabled
  const replies = t.messages ?? EMPTY
  const all = useMemo(() => (t.head ? [t.head, ...replies] : replies), [t.head, replies])
  const { rows, num, idOf, source, editing, editingState, rowMenu, picker, setPicker } = useP2pList(
    {
      messages: all,
      nameOf,
      people,
      draftKey: key,
      scope,
      canAct,
      mayPin: false,
      mayDelete,
      forwardSkip: null,
      threads: false,
    }
  )
  const head = t.head ? rows[0] : null
  const list = useMemo(() => (t.head ? rows.slice(1) : rows), [rows, t.head])
  const shared = useMemo(() => list.map(r => r.m), [list])
  const ownCount = useMemo(() => replies.filter(m => m.sender === me).length, [replies, me])
  useEscape(e => {
    if (!e.defaultPrevented) p2pThread.close()
  }, 'panel')
  const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'
  const scroll = useChatScroll({
    list: listRef,
    content: contentRef,
    scope,
    count: shared.length,
    lastId: shared[shared.length - 1]?.id,
    stale: t.loading && replies.length === 0,
    focus: focus !== null,
    detached: false,
    outCount: ownCount,
    onBottom: () => {
      if (visible()) void p2pThread.markRead()
    },
  })
  useEffect(() => {
    if (unseen && following && visible()) void p2pThread.markRead()
  }, [unseen, following])
  const fresh = newSince(shared, scroll.leftAt, me ?? undefined)
  const flash = useP2pFlash(listRef, scope, focus, num, shared, scroll.settle)

  // A quote in the root jumps in the channel; one in a reply, in the thread.
  const jumpMain = useCallback(
    (n: number) => {
      const id = idOf(n)
      if (!id) return
      if (!window.matchMedia('(min-width: 768px)').matches) p2pThread.close()
      void p2pDm.jumpTo(id)
    },
    [idOf]
  )
  const jumpHere = useCallback(
    (n: number) => {
      const id = idOf(n)
      if (id) void p2pThread.jumpTo(id)
    },
    [idOf]
  )

  const row = (r: { p: P2pMessage; m: Message }, root: boolean) => {
    const { p, m } = r
    return (
      <P2pRow
        key={p.id}
        p={p}
        m={m}
        mine={p.sender === me}
        pendingTip="Waiting for a member to come online"
        mentioned={pingsMe(p, me)}
        divider={false}
        flash={flash === m.id}
        canAct={canAct}
        canDelete={!root && mayDelete(p)}
        editing={editing && editingState?.id === p.id ? editing : null}
        draftKey={key}
        threads={false}
        onMenu={rowMenu}
        onJump={root ? jumpMain : jumpHere}
      />
    )
  }

  return (
    <ChatSourceProvider value={source}>
      <div data-p2p-thread className="contents">
        <ThreadPanelView
          onClose={p2pThread.close}
          overlays={
            scroll.positioned && fresh > 0 && <PresentBar count={fresh} onJump={scroll.toBottom} />
          }
          listRef={listRef}
          contentRef={contentRef}
          onScroll={scroll.onScroll}
          head={
            t.more && (
              <div className="flex justify-center py-2">
                <button onClick={() => void p2pThread.loadOlder()} className={textBtn}>
                  Show older replies
                </button>
              </div>
            )
          }
          root={
            head ? (
              row(head, true)
            ) : (
              <p className="px-4 py-1.5 text-sm text-on-surface-variant italic">
                {t.loading ? 'Loading…' : 'Message unavailable'}
              </p>
            )
          }
          count={t.head?.replies ?? replies.length}
          replies={list.map(r => row(r, false))}
          footer={
            <>
              <TypingIndicator
                scope={null}
                bg="bg-surface-container-low"
                names={typers.map(nameOf)}
              />
              <P2pComposer
                draftKey={key}
                scope={scope}
                title="the thread"
                placeholder="Message thread"
                nameOf={nameOf}
                disabled={disabled}
              />
            </>
          }
        />
        {picker && (
          <EmojiPicker
            anchor={picker.anchor?.isConnected ? picker.anchor : null}
            side="top"
            align="end"
            label="Add reaction"
            onPick={e => source.toggleReaction(picker.m, e, false)}
            onClose={() => setPicker(null)}
          />
        )}
      </div>
    </ChatSourceProvider>
  )
}
