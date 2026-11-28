'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Eye,
  EyeOff,
  File as FileIcon,
  Loader2,
  Plus,
  Server,
  Share2,
  Waypoints,
  X,
} from 'lucide-react'
import { describableFile } from '../lib/alt_text'
import type { UploadMode } from '../lib/attachments'
import { fmtSize } from '../lib/bytes'
import { FUNCTIONAL } from '../lib/motion/functional'
import type { Compose, DraftFile } from '../lib/place/composer'
import { useLive, usePlace } from '../lib/place/react'
import { downloadName } from '../lib/sniff'
import { AltField } from './alt_text'
import { Chip, IconButton } from './controls'
import { Inset, Row, Stack, Surface } from './layout'
import { useUploadHint } from './upload_expiry'

const modeTitle = (mode: UploadMode, switchable: boolean, hint: string) => {
  const what =
    mode === 'p2p'
      ? 'P2P: hosted from your browser while you are online, no size limit'
      : `Server: uploaded to the server, ${hint}`
  return switchable ? `${what}. Click for ${mode === 'p2p' ? 'server upload' : 'P2P'}` : what
}

function useThumb(compose: Compose, f: DraftFile) {
  const [url, setUrl] = useState<string | null>(null)
  const ready = f.status?.kind === 'ready'
  useEffect(() => {
    let live = true
    void compose.thumbOf(f.id).then(u => live && setUrl(u))
    return () => {
      live = false
    }
  }, [compose, f.id, ready])
  return url
}

function FileCard({ compose, f, peer }: { compose: Compose; f: DraftFile; peer: boolean }) {
  const place = usePlace()
  const hint = useUploadHint(place?.kind === 'hostedServer' ? place.server : null)
  const thumb = useThumb(compose, f)
  const { mode, status } = f
  return (
    <Surface
      data-pending-file
      pad="sm"
      tone="base"
      radius="lg"
      justify="between"
      look={`h-24 border ${peer ? 'border-dashed border-tertiary/60' : 'border-outline-variant'}`}
      place="relative"
    >
      <IconButton
        icon={X}
        label="Remove file"
        tone="filled-danger"
        size="xs"
        onClick={() => compose.detach(f.id)}
        place="absolute -top-2 -right-2"
      />
      <Row gap="2xs" justify="between">
        {thumb ? (
          <img src={thumb} alt="" aria-hidden className="h-10 w-14 rounded object-cover" />
        ) : (
          <FileIcon size={20} className={peer ? 'text-tertiary' : 'text-primary'} />
        )}
        <Row gap="2xs">
          {mode && (
            <Chip
              title={modeTitle(mode.now, mode.switchable, hint)}
              onClick={() => compose.toggleMode(f.id)}
              disabled={!mode.switchable}
              on={mode.now === 'p2p'}
              icon={mode.now === 'p2p' ? Share2 : Server}
            >
              {mode.now === 'p2p' ? 'P2P' : 'Server'}
            </Chip>
          )}
          <IconButton
            icon={f.spoiler ? EyeOff : Eye}
            label={f.spoiler ? 'Unmark spoiler' : 'Mark as spoiler'}
            size="sm"
            pressed={f.spoiler}
            onClick={() => compose.toggleSpoiler(f.id)}
          />
        </Row>
      </Row>
      <span className="truncate text-xs">
        {f.spoiler ? 'Spoiler · ' : ''}
        {downloadName(f.file.name)}
      </span>
      {status && (
        <Row as="span" gap="2xs">
          {status.kind === 'preparing' && (
            <Loader2 size={10} className={`text-on-surface-variant ${FUNCTIONAL.spinSafe}`} />
          )}
          <span
            className={`text-2xs tabular-nums ${status.kind === 'failed' ? 'text-error' : 'text-on-surface-variant'}`}
          >
            {status.kind === 'failed'
              ? status.why
              : status.kind === 'ready'
                ? fmtSize(status.bytes)
                : `Preparing ${Math.floor(status.done * 100)}%`}
          </span>
        </Row>
      )}
    </Surface>
  )
}

// The files held with a draft, each with its switches and its description field.
export function ComposerFiles({ compose }: { compose: Compose }) {
  const { held, peer } = useLive(compose.files)
  if (!held.length) return null
  return (
    <Surface
      pad="sm"
      tone="plain"
      radius="none"
      align="start"
      place="w-full overflow-x-auto"
      aria-label="Files to send"
    >
      <Row gap="md" align="stretch">
        {held.map(f => (
          <div key={f.id} className="w-48 shrink-0">
            <Stack gap="2xs">
              <FileCard compose={compose} f={f} peer={peer} />
              {describableFile(f.file.name, f.file.type) && (
                <div data-alt-field className="contents">
                  <AltField compact value={f.alt} onChange={v => compose.describe(f.id, v)} />
                </div>
              )}
            </Stack>
          </div>
        ))}
        {peer && (
          <Inset
            title="Sent peer-to-peer: stored on your devices and shared with the people in this conversation"
            as="span"
            row
            pad="xs"
            inset="chip"
            gap="2xs"
            look="rounded bg-tertiary-container text-2xs font-medium text-on-tertiary-container"
            place="shrink-0 self-end"
          >
            <Waypoints size={10} />
            P2P
          </Inset>
        )}
      </Row>
    </Surface>
  )
}

// The button that adds files to a draft; nothing where none can be added.
export function AttachButton({ compose }: { compose: Compose }) {
  const { add } = useLive(compose.files)
  const input = useRef<HTMLInputElement>(null)
  if (add === null) return null
  return (
    <>
      <IconButton
        icon={Plus}
        label={add === 'many' ? 'Attach files' : 'Attach a file'}
        tight
        onClick={() => input.current?.click()}
      />
      <input
        ref={input}
        type="file"
        multiple={add === 'many'}
        data-file-input
        className="hidden"
        onChange={e => {
          compose.attach(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
    </>
  )
}

// The files among what was pasted into a field.
export const pastedFiles = (e: { clipboardData: DataTransfer }) =>
  Array.from(e.clipboardData.items)
    .filter(i => i.kind === 'file')
    .map(i => i.getAsFile())
    .filter((f): f is File => f !== null)
