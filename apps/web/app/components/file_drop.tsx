'use client'

import { useRef, useState, type DragEvent } from 'react'
import type { ComposerList } from '../lib/place/composer'
import { isHosted, type Place } from '../lib/place/place'
import { useLive, usePlace } from '../lib/place/react'
import { composeAt, useCompose } from '../lib/place/use_composer'
import { useGate } from './composer_gate'

// Files dragged over a conversation go to the draft of its composer, where the place takes files
// and nothing stands in the composer's place. `off`: the pane shows something else than the
// conversation. Gives the pane's drag handlers and, while files hover, the note to draw over it.
export function useFileDrop({
  list = 'main',
  place,
  off = false,
}: {
  list?: ComposerList
  place?: Place
  off?: boolean
} = {}) {
  const around = usePlace()
  const own = useCompose(list)
  const compose = place ? composeAt(place, list) : own
  const takes = useLive(compose.files).add !== null
  const { shut } = useGate(compose)
  const open = takes && !shut && !off
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const here = place ?? around
  const peer = here !== null && !isHosted(here)
  return {
    handlers: {
      onDragEnter: (e: DragEvent) => {
        e.preventDefault()
        if (!open || !e.dataTransfer.types.includes('Files')) return
        depth.current += 1
        setDragging(true)
      },
      onDragOver: (e: DragEvent) => e.preventDefault(),
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1)
        if (!depth.current) setDragging(false)
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault()
        depth.current = 0
        setDragging(false)
        if (open) compose.attach(Array.from(e.dataTransfer.files))
      },
    },
    note: dragging && (
      <div
        data-drop-note
        className={`pointer-events-none absolute inset-2 z-raised flex items-center justify-center rounded-2xl border-2 border-dashed bg-surface/80 font-medium ${
          peer ? 'border-tertiary text-tertiary' : 'border-primary text-primary'
        }`}
      >
        {peer ? 'Drop files to send peer-to-peer' : 'Drop file to attach'}
      </div>
    ),
  }
}
