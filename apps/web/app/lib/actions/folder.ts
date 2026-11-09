// What can be done with a server folder in the rail. The folder's menu reads this list.

import { Palette } from 'lucide-react'
import { FOLDER_PRESETS } from '../folder_colors'
import type { Folder } from '../nav_layout'
import { p2p, p2pRail, useP2p } from '../p2p/app'
import type { Action, ActionCtx, ArgChoice } from './types'

const CUSTOM = 'custom'
const DEFAULT = 'default'

// The target folder as its rail has it now.
const folderNow = ({ s, target }: ActionCtx): { folder: Folder; p2p: boolean } | null => {
  if (target.kind !== 'folder') return null
  const inP2p = target.p2p === true
  const entries = inP2p ? useP2p.getState().layout.servers : s.layout.servers
  const folder = entries.find(
    (e): e is Folder => typeof e !== 'string' && e.id === target.folder.id
  )
  return folder ? { folder, p2p: inP2p } : null
}

const colorChoices = (ctx: ActionCtx): ArgChoice[] => {
  const color = folderNow(ctx)?.folder.color ?? null
  const preset = FOLDER_PRESETS.some(p => p.color === color)
  const custom = color !== null && !preset
  return [
    ...FOLDER_PRESETS.map(p => ({
      value: p.color,
      label: p.label,
      swatch: p.color,
      radio: true,
      checked: p.color === color,
    })),
    {
      value: CUSTOM,
      label: 'Custom color',
      ...(custom ? { swatch: color } : {}),
      radio: true,
      checked: custom,
    },
    { value: DEFAULT, label: 'Default', radio: true, checked: color === null },
  ]
}

export const folderActions: Action[] = [
  {
    id: 'folder_color',
    title: 'Folder color',
    scope: 'server',
    order: 200,
    icon: Palette,
    keywords: ['folder', 'color', 'colour'],
    targets: ['folder'],
    available: ctx => folderNow(ctx) !== null,
    args: [{ kind: 'choice', name: 'color', prompt: 'Folder color', choices: colorChoices }],
    run: (ctx, { color }) => {
      const now = folderNow(ctx)
      if (!now) return
      const id = now.folder.id
      if (color === CUSTOM) {
        if (now.p2p) p2p.openDialog({ kind: 'p2p_folder', id, focus: 'color' })
        else ctx.s.openDialog({ kind: 'rename_folder', id, focus: 'color' })
        return
      }
      const next = color === DEFAULT ? null : color
      if (now.p2p) p2pRail.setFolderColor(id, next)
      else ctx.s.setFolderColor(id, next)
    },
  },
]
