// The menu of a file card, hosted or P2P. Each row reads the card as it is when it runs.

import { Copy, Download, Link, Trash2, X } from 'lucide-react'
import { EXTRAS, type FileExtra } from '../file_card'
import { sharing } from '../platform'
import type { Action, ActionCtx } from './types'

const copy = (text: string) => void sharing().copyText(text)

const cardOf = ({ target }: ActionCtx) => (target.kind === 'file' ? target.now() : null)

const file = { scope: 'message', targets: ['file'] } as const

// A row for one of the card's own buttons beside its main one, while the card shows it.
const extra = (kind: FileExtra['kind'], id: string, order: number): Action => {
  const pick = (ctx: ActionCtx) => cardOf(ctx)?.extra.find(x => x.kind === kind) ?? null
  return {
    id,
    title: EXTRAS[kind].label,
    icon: EXTRAS[kind].icon,
    ...file,
    order,
    available: ctx => pick(ctx) !== null,
    run: ctx => pick(ctx)?.run(),
  }
}

export const fileActions: Action[] = [
  {
    id: 'file_download',
    title: 'Download',
    label: ctx => cardOf(ctx)?.verb ?? 'Download',
    icon: Download,
    ...file,
    order: 100,
    available: ctx => !!cardOf(ctx)?.download,
    run: ctx => cardOf(ctx)?.download?.(),
  },
  {
    id: 'file_cancel',
    title: 'Cancel download',
    icon: X,
    ...file,
    order: 100,
    available: ctx => !!cardOf(ctx)?.cancel,
    run: ctx => cardOf(ctx)?.cancel?.(),
  },
  extra('image', 'file_show_image', 110),
  extra('preview', 'file_show_preview', 120),
  extra('audio', 'file_play_audio', 130),
  extra('video', 'file_play_video', 130),
  {
    id: 'file_copy_link',
    title: 'Copy link',
    icon: Link,
    ...file,
    order: 200,
    available: ctx => !!cardOf(ctx)?.link,
    run: ctx => {
      const link = cardOf(ctx)?.link
      if (link) copy(link)
    },
  },
  {
    id: 'file_copy_name',
    title: 'Copy file name',
    icon: Copy,
    ...file,
    order: 210,
    available: ctx => cardOf(ctx) !== null,
    run: ctx => {
      const card = cardOf(ctx)
      if (card) copy(card.name)
    },
  },
  {
    id: 'file_remove',
    title: 'Remove attachment',
    icon: Trash2,
    danger: true,
    ...file,
    order: 300,
    available: ctx => !!cardOf(ctx)?.remove,
    run: ctx => cardOf(ctx)?.remove?.(),
  },
]
