'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { Folder as FolderIcon, FolderOpen } from 'lucide-react'
import { folderLabel, useStore } from '../lib/store'
import { FOLDER_BASE, FOLDER_PRESETS, folderStyle } from '../lib/folder_colors'
import { FOLDER_NAME_MAX, type Folder } from '../lib/nav_layout'
import { enterKey } from '../lib/keys'
import { ColorField } from './color_field'
import { Dialog, fieldCls, filledBtn, textBtn } from './ui'

// The color choice of a folder with a preview of it open and closed. `tone` marks a P2P folder.
export function FolderColorField({
  color,
  onColor,
  tone = 'primary',
}: {
  color: string | null
  onColor: (color: string | null) => void
  tone?: 'primary' | 'tertiary'
}) {
  const theme = useStore(s => s.theme)
  const style = folderStyle(color, theme) as CSSProperties | undefined
  const p2p = tone === 'tertiary'
  return (
    <div className="mt-4 flex flex-col gap-2">
      <span className="text-sm text-on-surface-variant">Folder color</span>
      <div className="flex items-start gap-4">
        <div aria-hidden className="flex shrink-0 flex-col items-center gap-2">
          <span
            style={style}
            className="folder-group flex size-12 items-center justify-center rounded-2xl"
          >
            <FolderOpen
              size={22}
              className={
                p2p
                  ? 'text-(--folder-icon,var(--color-tertiary))'
                  : 'text-(--folder-icon,var(--color-primary))'
              }
            />
          </span>
          <span
            style={style}
            className={`folder-tile relative flex size-12 items-center justify-center rounded-2xl ${
              p2p ? 'border-2 border-dashed border-tertiary' : ''
            }`}
          >
            <span className="grid size-8 grid-cols-2 grid-rows-2 gap-1">
              {[0, 1, 2, 3].map(i => (
                <span key={i} className="folder-mini rounded-md" />
              ))}
            </span>
            <span
              className={`absolute -right-1 -bottom-1 flex size-4.5 items-center justify-center rounded-full border-2 border-surface-container-high ${
                p2p
                  ? 'bg-(--folder-icon,var(--color-tertiary)) text-(--folder-on-icon,var(--color-on-tertiary))'
                  : 'folder-badge'
              }`}
            >
              <FolderIcon size={9} strokeWidth={2.5} />
            </span>
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <ColorField
            label="Folder color"
            value={color}
            shown={color ?? FOLDER_BASE[theme].icon}
            onChange={onColor}
            presets={FOLDER_PRESETS}
            defaultNote="Default"
            resetLabel="Use default"
          />
        </div>
      </div>
    </div>
  )
}

function EditFolder({ folder, colorFirst }: { folder: Folder; colorFirst: boolean }) {
  const closeDialog = useStore(s => s.closeDialog)
  const renameFolder = useStore(s => s.renameFolder)
  const setFolderColor = useStore(s => s.setFolderColor)
  const fallback = useStore(s => (s.streamer ? 'Folder name' : folderLabel(s, folder, null)))
  const [name, setName] = useState(folder.name ?? '')
  const [color, setColor] = useState(folder.color ?? null)
  const save = () => {
    renameFolder(folder.id, name)
    setFolderColor(folder.id, color)
    closeDialog()
  }
  return (
    <Dialog title="Edit folder" onClose={closeDialog}>
      <input
        autoFocus={!colorFirst}
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
      <FolderColorField color={color} onColor={setColor} />
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
  const colorFirst = useStore(
    s => s.activeDialog?.kind === 'rename_folder' && s.activeDialog.focus === 'color'
  )
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
  return folder ? <EditFolder key={folder.id} folder={folder} colorFirst={colorFirst} /> : null
}
