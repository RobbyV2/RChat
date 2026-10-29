'use client'

import { useEffect, useState } from 'react'
import { useStore } from '../lib/store'
import { NAME_MAX } from '../lib/rules'
import { enterKey } from '../lib/keys'
import { Dialog, fieldCls, filledBtn, textBtn } from './ui'

function CategoryForm({ server, id, initial }: { server: string; id?: number; initial: string }) {
  const closeDialog = useStore(s => s.closeDialog)
  const createCategory = useStore(s => s.createCategory)
  const renameCategory = useStore(s => s.renameCategory)
  const [name, setName] = useState(initial)
  const trimmed = name.trim()
  const save = () => {
    if (!trimmed) return
    closeDialog()
    void (id === undefined ? createCategory(server, trimmed) : renameCategory(id, trimmed))
  }
  return (
    <Dialog title={id === undefined ? 'Create category' : 'Rename category'} onClose={closeDialog}>
      <input
        autoFocus
        value={name}
        maxLength={NAME_MAX}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (enterKey(e)) save()
        }}
        placeholder="Category name"
        aria-label="Category name"
        className={`${fieldCls} w-full`}
      />
      <p className="pt-1.5 text-xs text-on-surface-variant">
        Text and voice channels can both go in a category.
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={closeDialog} className={textBtn}>
          Cancel
        </button>
        <button onClick={save} disabled={!trimmed} className={filledBtn}>
          {id === undefined ? 'Create' : 'Save'}
        </button>
      </div>
    </Dialog>
  )
}

export function CategoryDialog() {
  const dialog = useStore(s => (s.activeDialog?.kind === 'category' ? s.activeDialog : null))
  const name = useStore(s =>
    dialog?.id === undefined
      ? ''
      : s.servers[dialog.server]?.categories?.find(c => c.id === dialog.id)?.name
  )
  const closeDialog = useStore(s => s.closeDialog)
  const gone = dialog !== null && name === undefined
  useEffect(() => {
    if (gone) closeDialog()
  }, [gone, closeDialog])
  if (!dialog || name === undefined) return null
  return (
    <CategoryForm
      key={`${dialog.server}:${dialog.id ?? 'new'}`}
      server={dialog.server}
      id={dialog.id}
      initial={name}
    />
  )
}
