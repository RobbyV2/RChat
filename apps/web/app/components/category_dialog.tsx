'use client'

import { useEffect, useState } from 'react'
import { useStore } from '../lib/store'
import { NAME_MAX } from '../lib/rules'
import { enterKey } from '../lib/keys'
import { Button } from './controls'
import { Row, Stack } from './layout'
import { SeparatorForm } from './channel_separator'
import { Dialog, fieldCls, useOwnServer } from './ui'

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
      <Stack gap="xl">
        <Stack gap="xs">
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
          <p className="text-xs text-on-surface-variant">
            Text and voice channels can both go in a category.
          </p>
        </Stack>
        <Row gap="sm" justify="end">
          <Button size="md" onClick={closeDialog}>
            Cancel
          </Button>
          <Button variant="filled" size="md" onClick={save} disabled={!trimmed}>
            {id === undefined ? 'Create' : 'Save'}
          </Button>
        </Row>
      </Stack>
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

// A hosted server's separator form: a new one at the end of a list, or one to edit.
export function SeparatorDialog() {
  const dialog = useStore(s => (s.activeDialog?.kind === 'separator' ? s.activeDialog : null))
  const separator = useStore(s =>
    dialog?.id === undefined
      ? null
      : s.servers[dialog.server]?.separators?.find(x => x.id === dialog.id)
  )
  const closeDialog = useStore(s => s.closeDialog)
  const createSeparator = useStore(s => s.createSeparator)
  const editSeparator = useStore(s => s.editSeparator)
  const own = useOwnServer(dialog?.server)
  const gone = dialog !== null && separator === undefined
  useEffect(() => {
    if (gone) closeDialog()
  }, [gone, closeDialog])
  if (!dialog || separator === undefined) return null
  return (
    <SeparatorForm
      key={`${dialog.server}:${dialog.id ?? 'new'}`}
      editing={separator !== null}
      initial={separator ?? { label: '', style: 'dots' }}
      own={own}
      onClose={closeDialog}
      onSave={(label, style) =>
        void (separator
          ? editSeparator(separator.id, { label, style })
          : createSeparator(dialog.server, label, style, dialog.category ?? null))
      }
    />
  )
}
