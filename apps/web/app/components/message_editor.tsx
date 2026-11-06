'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { useStore, type ContextMenuItem } from '../lib/store'
import { limitsOf } from '../lib/instance_limits'
import { charCount, counterFrom } from '../lib/rules'
import { sendKey } from '../lib/keys'
import type { ToolbarAction } from './message_toolbar'
import { useMedia } from './context_menu'
import { useTextAssist } from './text_assist'
import { FormatToolbar, useFormatting } from './format_toolbar'
import { fullTimeOf } from '../lib/timestamps'

export const editAction = (onClick: () => void): ToolbarAction => ({
  key: 'edit',
  label: 'Edit',
  icon: Pencil,
  onClick,
})

export const editMenuItem = (action: () => void): ContextMenuItem => ({
  label: 'Edit Message',
  icon: Pencil,
  action,
})

export function EditedMark({ at }: { at: number }) {
  const when = fullTimeOf(at)
  return (
    <span
      data-edited
      title={when}
      aria-label={`Edited ${when}`}
      className="ml-1 cursor-default align-baseline text-[0.7rem] text-on-surface-variant select-none"
    >
      (edited)
    </span>
  )
}

const linkCls =
  'rounded-sm font-medium text-primary outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary'

const POPUP_ROOM = 340

const touchBtn = 'min-h-10 rounded-full px-4 text-sm font-medium'

// An edit box bound to something other than the store's edit state (a P2P conversation).
export interface EditBinding {
  max: number
  text: string
  listKey: string
  focus: number
  getText: () => string
  setText: (text: string) => void
  save: (fine: boolean) => void
  cancel: (fine: boolean) => void
}

export function MessageEditor({ binding }: { binding?: EditBinding }) {
  const storeText = useStore(s => s.editing?.text ?? '')
  const storeKey = useStore(s => s.editing?.key ?? null)
  const storeFocus = useStore(s => s.editing?.focus ?? 0)
  const storeSet = useStore(s => s.setEditText)
  const storeSave = useStore(s => s.saveEdit)
  const storeCancel = useStore(s => s.cancelEdit)
  const storeMax = useStore(s => limitsOf(s.instance).message_chars)
  const max = binding ? binding.max : storeMax
  const text = binding ? binding.text : storeText
  const listKey = binding ? binding.listKey : storeKey
  const focusAsk = binding ? binding.focus : storeFocus
  const setEditText = binding ? binding.setText : storeSet
  const saveEdit = binding ? binding.save : storeSave
  const cancelEdit = binding ? binding.cancel : storeCancel
  const fine = useMedia('(pointer: fine)')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [below, setBelow] = useState(false)
  useLayoutEffect(() => {
    const el = inputRef.current
    const scroller = el?.closest('.overflow-y-auto')
    if (!el || !scroller) return
    const room = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    setBelow(room < POPUP_ROOM)
  }, [text])
  const assist = useTextAssist({
    listKey,
    text,
    getText: binding ? binding.getText : () => useStore.getState().editing?.text ?? '',
    setText: setEditText,
    inputRef,
    paused: false,
    maxHeight: 320,
    below,
  })
  const { trackCaret } = assist
  const formatting = useFormatting({
    inputRef,
    getText: () => useStore.getState().editing?.text ?? '',
    setText: setEditText,
  })

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    const end = el.value.length
    el.setSelectionRange(end, end)
    el.scrollTop = el.scrollHeight
    el.scrollIntoView({ block: 'nearest' })
    trackCaret(el)
  }, [focusAsk])

  const count = charCount(text)
  const tooLong = count > max
  const save = () => saveEdit(fine)
  const cancel = () => cancelEdit(fine)

  return (
    <div
      data-editor
      className="mt-1"
      onContextMenu={e => e.stopPropagation()}
      onTouchStart={e => e.stopPropagation()}
    >
      <div className="relative flex items-end gap-2 rounded-xl bg-surface-container-high px-3 py-2">
        {assist.popups}
        <FormatToolbar open={formatting.selected} onFormat={formatting.apply} below={below} />
        <textarea
          ref={inputRef}
          rows={1}
          aria-label="Edit message"
          {...assist.textarea}
          onKeyDown={e => {
            if (assist.popupKey(e)) return
            if (formatting.onKeyDown(e)) return
            if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              cancel()
              return
            }
            if (sendKey(e)) {
              e.preventDefault()
              save()
            }
          }}
          className="max-h-80 flex-1 resize-none bg-transparent py-0.5 text-base leading-relaxed outline-none md:text-sm"
        />
        {count > counterFrom(max) && (
          <span
            title={`Messages can be up to ${max} characters`}
            className={`shrink-0 self-center text-xs tabular-nums ${tooLong ? 'font-medium text-error' : 'text-on-surface-variant'}`}
          >
            {max - count}
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-on-surface-variant pointer-coarse:hidden">
        escape to{' '}
        <button type="button" onClick={cancel} className={linkCls}>
          cancel
        </button>{' '}
        • enter to{' '}
        <button
          type="button"
          onClick={save}
          disabled={tooLong}
          className={`${linkCls} disabled:opacity-40`}
        >
          save
        </button>
      </div>
      <div className="mt-1.5 flex justify-end gap-2 pointer-fine:hidden">
        <button
          type="button"
          onClick={cancel}
          className={`${touchBtn} text-on-surface-variant hover:bg-surface-container-high`}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={tooLong}
          className={`${touchBtn} bg-primary text-on-primary disabled:opacity-40`}
        >
          Save
        </button>
      </div>
    </div>
  )
}
