'use client'

import { useEffect, useState } from 'react'
import { folderLabel, useStore } from '../lib/store'
import { FOLDER_NAME_MAX, type Folder } from '../lib/nav_layout'
import { enterKey } from '../lib/keys'
import { Dialog, fieldCls, filledBtn, textBtn } from './server_settings'

function RenameFolder({ folder }: { folder: Folder }) {
  const closeDialog = useStore(s => s.closeDialog)
  const renameFolder = useStore(s => s.renameFolder)
  const fallback = useStore(s => (s.streamer ? 'Folder name' : folderLabel(s, folder, null)))
  const [name, setName] = useState(folder.name ?? '')
  const save = () => {
    renameFolder(folder.id, name)
    closeDialog()
  }
  return (
    <Dialog title="Rename folder" onClose={closeDialog}>
      <input
        autoFocus
        value={name}
        maxLength={FOLDER_NAME_MAX}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (enterKey(e)) save()
        }}
        placeholder={fallback}
        aria-label="Folder name"
        className={`${fieldCls} w-full`}
      />
      <p className="pt-1.5 text-xs text-on-surface-variant">
        Shown when hovering the folder. Leave empty to list its servers.
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={closeDialog} className={textBtn}>
          Cancel
        </button>
        <button onClick={save} className={filledBtn}>
          Save
        </button>
      </div>
    </Dialog>
  )
}

export function FolderDialog() {
  const id = useStore(s => (s.activeDialog?.kind === 'rename_folder' ? s.activeDialog.id : null))
  const folder = useStore(s =>
    id === null
      ? undefined
      : s.layout.servers.find((e): e is Folder => typeof e !== 'string' && e.id === id)
  )
  const closeDialog = useStore(s => s.closeDialog)
  const gone = id !== null && folder === undefined
  useEffect(() => {
    if (gone) closeDialog()
  }, [gone, closeDialog])
  return folder ? <RenameFolder key={folder.id} folder={folder} /> : null
}
