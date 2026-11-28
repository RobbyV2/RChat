'use client'

import { Name } from './name'
import { handleName, personCalled } from '../lib/names'
import { shownUser } from '../lib/people'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { useStore } from '../lib/store'
import type { UserRef } from '../lib/types'
import { MENTION_QUERY, mentionText } from '../lib/mention_suggest'
import { findTrigger, spliceText } from '../lib/autocomplete'
import {
  boostFor,
  emojiFailed,
  findShortcode,
  matchShortcodes,
  withTone,
  type CodeMatch,
} from '../lib/emoji'
import { refusalView } from '../lib/api_errors'
import { AutocompletePopup, useAutocomplete } from './autocomplete'
import { useChat } from '../lib/place/use_chat'
import { useLive } from '../lib/place/react'
import { useEmojiNow } from './emoji_picker'
import { UserAvatar } from './user_avatar'
import {
  STYLE_LABELS,
  acceptStamp,
  findStampTrigger,
  stampChoices,
  type StampChoice,
} from '../lib/timestamps'
import { time } from '../lib/platform/time'

type Suggestion =
  | { kind: 'user'; user: UserRef }
  | { kind: 'group'; key: string; label: string; color: string | null; hint: string }

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
  const chat = useChat()
  const mentions = useMemo(
    () => chat.people(listKey?.[0] === 't' ? 'thread' : 'main'),
    [chat, listKey]
  )
  const findPeople = useLive(mentions.find)
  const findGroups = useLive(mentions.groups)
  const peopleTrouble = useLive(mentions.trouble)
  const asked = atTrigger?.query ?? null
  useEffect(() => {
    mentions.ask(asked)
    return () => mentions.ask(null)
  }, [mentions, asked])
  const searchPeople = useCallback(
    (q: string): Suggestion[] => {
      const groups = findGroups(q).map(g => ({ kind: 'group' as const, ...g }))
      const users = findPeople(q)
        .slice(0, 10 - groups.length)
        .map(user => ({ kind: 'user' as const, user }))
      return [...users, ...groups]
    },
    [findPeople, findGroups]
  )
  const emoji = useEmojiNow(trigger !== null)
  const emojiMissing = trigger !== null && emojiFailed()
  const searchCodes = useCallback(
    (q: string) => (emoji ? matchShortcodes(emoji, q, 10, boostFor(prefs, time().now())) : []),
    [emoji, prefs]
  )

  const searchStamps = useCallback((q: string) => {
    const now = time().now()
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
        note={
          emojiMissing
            ? 'Emoji names could not load. Check your connection, then type the name again.'
            : undefined
        }
        keyOf={m => m.emoji.emoji}
        render={m => (
          <>
            <span className="w-7 shrink-0 text-center font-emoji text-2xl leading-none">
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
        note={
          atTrigger !== null && peopleTrouble !== null
            ? `Could not search all members. ${refusalView(peopleTrouble).line} These are the people already loaded.`
            : undefined
        }
        keyOf={u => (u.kind === 'user' ? u.user.username : `\n${u.key}`)}
        render={u =>
          u.kind === 'user' ? (
            <>
              <UserAvatar person={shownUser(u.user, null)} size={24} />
              <Name
                of={personCalled(u.user.display_name, u.user.username)}
                look="min-w-0 truncate font-medium"
              />
              <Name
                of={handleName(u.user.username)}
                before="@"
                look="min-w-0 shrink truncate text-xs opacity-70"
              />
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
