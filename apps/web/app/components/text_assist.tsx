'use client'

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { serverAdminPerms, useStore, viewKey } from '../lib/store'
import { api } from '../lib/instances'
import { Perm, hasPerm, type Message, type Role, type UserRef } from '../lib/types'
import {
  MENTION_QUERY,
  SUGGEST_DEBOUNCE,
  groupSuggestions,
  mentionText,
  recentAuthors,
  suggestKey,
  suggestPeople,
} from '../lib/mention_suggest'
import { findTrigger, spliceText } from '../lib/autocomplete'
import { boostFor, findShortcode, matchShortcodes, withTone, type CodeMatch } from '../lib/emoji'
import { AutocompletePopup, useAutocomplete } from './autocomplete'
import { useEmojiData } from './emoji_picker'
import { UserAvatar } from './user_avatar'
import {
  STYLE_LABELS,
  acceptStamp,
  findStampTrigger,
  stampChoices,
  type StampChoice,
} from '../lib/timestamps'

const NO_MESSAGES: Message[] = []
const NO_PEOPLE: UserRef[] = []
const CACHE_MAX = 200

// Mention suggestions: recent authors in view, then server members that match the query
// (debounced and cached), then cached members. DMs suggest the other person.
function useMentionSearch(listKey: string | null, query: string | null) {
  const me = useStore(s => s.me?.username ?? null)
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const dmOther = useStore(s => {
    const v = s.view
    return v?.kind === 'dm' ? (s.dms.find(d => d.id === v.dmId)?.other ?? null) : null
  })
  const own = useStore(s => (listKey ? s.messages[listKey] : undefined)) ?? NO_MESSAGES
  const parent =
    useStore(s =>
      listKey?.[0] === 't' && s.view?.kind === 'channel' ? s.messages[viewKey(s.view)] : undefined
    ) ?? NO_MESSAGES
  const list = useStore(s => (server ? s.members[server]?.list : undefined)) ?? NO_PEOPLE
  const info = useStore(s => (server ? s.memberInfo[server] : undefined))
  const cache = useRef(new Map<string, UserRef[]>())
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!server || !query) return
    const key = suggestKey(server, query)
    if (cache.current.has(key)) return
    const t = setTimeout(() => {
      api
        .suggestMembers(server, query)
        .then(found => {
          if (cache.current.size >= CACHE_MAX) cache.current.clear()
          cache.current.set(key, found)
          setTick(n => n + 1)
        })
        .catch(() => {})
    }, SUGGEST_DEBOUNCE)
    return () => clearTimeout(t)
  }, [server, query])

  return useCallback(
    (q: string): UserRef[] => {
      void tick
      if (dmOther) return suggestPeople(q, [[dmOther]], () => false)
      if (!server) return []
      let remote: UserRef[] = NO_PEOPLE
      for (let n = q.length; n > 0; n -= 1) {
        const hit = cache.current.get(suggestKey(server, q.slice(0, n)))
        if (hit) {
          remote = hit
          break
        }
      }
      return suggestPeople(
        q,
        [recentAuthors(own), recentAuthors(parent), remote, list],
        name => name === me || info?.[name] === null
      )
    },
    [tick, dmOther, server, own, parent, list, info, me]
  )
}

const NO_ROLES: Role[] = []

type Suggestion =
  | { kind: 'user'; user: UserRef }
  | { kind: 'group'; key: string; label: string; color: string | null; hint: string }

// `@everyone`, `@here` and roles you may mention in a channel (not in threads or DMs): all of
// them with Mention everyone and roles, otherwise roles that allow anyone.
function useGroupSearch(listKey: string | null) {
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const member = useStore(s => !!server && !!s.me?.servers.some(x => x.name === server))
  const allowed = useStore(s =>
    server ? hasPerm(serverAdminPerms(s, server), Perm.MentionEveryone) : false
  )
  const roles = useStore(s => (server ? s.servers[server]?.roles : undefined)) ?? NO_ROLES
  const open = member && listKey?.[0] === 'c'
  return useCallback(
    (q: string): Suggestion[] =>
      open
        ? groupSuggestions(q, allowed, roles).map(g => ({
            kind: 'group' as const,
            key: g.key,
            label: g.label,
            color: g.color,
            hint: g.hint,
          }))
        : [],
    [open, allowed, roles]
  )
}

// `:shortcode`, `@mention` and `<t:` timestamp autocomplete for a message box, and auto-grow up
// to `maxHeight`. `listKey` is the message list of the box. `getText` reads the text when the
// user accepts an item.
export function useTextAssist({
  listKey,
  text,
  getText,
  setText,
  inputRef,
  paused,
  maxHeight,
  below = false,
}: {
  listKey: string | null
  text: string
  getText: () => string
  setText: (value: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  paused: boolean
  maxHeight: number
  below?: boolean
}) {
  const prefs = useStore(s => s.emoji)
  const noteEmoji = useStore(s => s.noteEmoji)
  const [caret, setCaret] = useState<number | null>(null)
  const placeCaret = useRef<number | null>(null)
  const acId = useId()
  const peopleId = useId()
  const stampId = useId()

  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    const at = placeCaret.current
    placeCaret.current = null
    if (at !== null && document.activeElement === el) {
      el.setSelectionRange(at, at)
      setCaret(at)
    }
  }, [text, listKey, inputRef, maxHeight])

  const stampTrigger = caret !== null && !paused ? findStampTrigger(text, caret) : null
  const trigger =
    caret !== null && !paused && !stampTrigger ? findTrigger(text, caret, ':', 2) : null
  const atTrigger =
    caret !== null && !paused && !trigger && !stampTrigger
      ? findTrigger(text, caret, '@', 0, MENTION_QUERY)
      : null
  const searchUsers = useMentionSearch(listKey, atTrigger?.query ?? null)
  const searchGroups = useGroupSearch(listKey)
  const searchPeople = useCallback(
    (q: string): Suggestion[] => {
      const groups = searchGroups(q)
      const users = searchUsers(q)
        .slice(0, 10 - groups.length)
        .map(user => ({ kind: 'user' as const, user }))
      return [...users, ...groups]
    },
    [searchUsers, searchGroups]
  )
  const { data: emoji } = useEmojiData(trigger !== null)
  const searchCodes = useCallback(
    (q: string) => (emoji ? matchShortcodes(emoji, q, 10, boostFor(prefs, Date.now())) : []),
    [emoji, prefs]
  )

  const searchStamps = useCallback((q: string) => {
    const now = Date.now()
    return stampChoices(q ? Number(q) : Math.floor(now / 1000), now)
  }, [])

  const ac = useAutocomplete<CodeMatch>({
    scope: trigger ? `${listKey}:${trigger.start}` : null,
    query: trigger?.query ?? '',
    search: searchCodes,
    onAccept: m => {
      if (!trigger) return
      const picked = withTone(m.emoji, prefs.tone)
      const cur = getText()
      const pad = /\s/.test(cur[trigger.end] ?? '') ? '' : ' '
      placeCaret.current = trigger.start + picked.length + pad.length
      setText(spliceText(cur, trigger.start, trigger.end, picked + pad))
      noteEmoji(m.emoji.emoji, picked)
      inputRef.current?.focus()
    },
  })

  const people = useAutocomplete<Suggestion>({
    scope: atTrigger ? `${listKey}@${atTrigger.start}` : null,
    query: atTrigger?.query ?? '',
    search: searchPeople,
    onAccept: u => {
      if (!atTrigger) return
      const token = u.kind === 'user' ? mentionText(u.user.username) : u.label
      const cur = getText()
      const pad = /\s/.test(cur[atTrigger.end] ?? '') ? '' : ' '
      placeCaret.current = atTrigger.start + token.length + pad.length
      setText(spliceText(cur, atTrigger.start, atTrigger.end, token + pad))
      inputRef.current?.focus()
    },
  })
  const stamps = useAutocomplete<StampChoice>({
    scope: stampTrigger ? `${listKey}<${stampTrigger.start}` : null,
    query: String(stampTrigger?.seconds ?? ''),
    search: searchStamps,
    onAccept: c => {
      if (!stampTrigger) return
      const next = acceptStamp(getText(), stampTrigger, c.token)
      placeCaret.current = next.caret
      setText(next.text)
      inputRef.current?.focus()
    },
  })
  const popup = stamps.open ? stamps : people.open ? people : ac
  const popupId = stamps.open ? stampId : people.open ? peopleId : acId

  const onType = (value: string, at: number | null) => {
    if (emoji && at !== null && value[at - 1] === ':' && value.length === text.length + 1) {
      const t = findTrigger(value, at - 1, ':', 2)
      const hit = t ? findShortcode(emoji, t.query) : null
      if (t && hit) {
        const picked = withTone(hit, prefs.tone)
        placeCaret.current = t.start + picked.length
        setText(spliceText(value, t.start, at, picked))
        noteEmoji(hit.emoji, picked)
        return
      }
    }
    setText(value)
  }

  const trackCaret = (el: HTMLTextAreaElement) =>
    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null)

  const popups = (
    <>
      <AutocompletePopup
        id={acId}
        title={`Emoji matching :${trigger?.query ?? ''}`}
        ac={ac}
        below={below}
        keyOf={m => m.emoji.emoji}
        render={m => (
          <>
            <span className="w-7 shrink-0 text-center font-emoji text-[22px] leading-none">
              {withTone(m.emoji, prefs.tone)}
            </span>
            <span className="min-w-0 truncate">:{m.code}:</span>
          </>
        )}
      />
      <AutocompletePopup
        id={stampId}
        title="Timestamp"
        ac={stamps}
        below={below}
        keyOf={c => c.style}
        render={c => (
          <>
            <span className="min-w-0 flex-1 truncate font-medium">{c.preview}</span>
            <span className="shrink-0 text-xs opacity-70">{STYLE_LABELS[c.style]}</span>
          </>
        )}
      />
      <AutocompletePopup
        id={peopleId}
        title="Members"
        ac={people}
        below={below}
        keyOf={u => (u.kind === 'user' ? u.user.username : `\n${u.key}`)}
        render={u =>
          u.kind === 'user' ? (
            <>
              <UserAvatar
                username={u.user.username}
                avatarKind={u.user.avatar_kind}
                avatarColor={u.user.avatar_color}
                size={24}
              />
              <span className="streamer min-w-0 truncate font-medium">{u.user.display_name}</span>
              <span className="streamer min-w-0 shrink truncate text-xs opacity-70">
                @{u.user.username}
              </span>
            </>
          ) : (
            <>
              <span
                aria-hidden
                style={u.color ? { color: u.color, backgroundColor: `${u.color}26` } : undefined}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${u.color ? '' : 'bg-on-surface/10 text-on-surface'}`}
              >
                @
              </span>
              <span
                style={u.color ? { color: u.color } : undefined}
                className="min-w-0 truncate font-medium"
              >
                {u.label}
              </span>
              <span className="min-w-0 shrink truncate text-xs opacity-70">{u.hint}</span>
            </>
          )
        }
      />
    </>
  )

  return {
    popups,
    trackCaret,
    // Spread on the textarea; `onKeyDown` gives the popups their turn first.
    textarea: {
      value: text,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const el = e.currentTarget
        onType(el.value, el.selectionStart === el.selectionEnd ? el.selectionStart : null)
        trackCaret(el)
      },
      onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => trackCaret(e.currentTarget),
      onBlur: () => setCaret(null),
      role: 'combobox' as const,
      'aria-autocomplete': 'list' as const,
      'aria-haspopup': 'listbox' as const,
      'aria-expanded': popup.open,
      'aria-controls': popup.open ? popupId : undefined,
      'aria-activedescendant': popup.open ? `${popupId}-${popup.active}` : undefined,
    },
    popupKey: (e: KeyboardEvent<HTMLTextAreaElement>) =>
      stamps.onKeyDown(e) || ac.onKeyDown(e) || people.onKeyDown(e),
  }
}
