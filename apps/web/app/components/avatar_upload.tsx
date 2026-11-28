'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ImageUp, Trash2 } from 'lucide-react'
import {
  AVATAR_ACCEPT,
  imageError,
  maxZoom,
  moved,
  sourceError,
  startCrop,
  zoomOf,
  zoomed,
  type AvatarCrop,
} from '../lib/avatar_images'
import { Button } from './controls'
import { Row, Stack } from './layout'
import { Dialog, FieldError } from './ui'
import { notAName } from '../lib/names'

// Where a profile editor keeps an uploaded picture: an account or a server profile on an
// instance, or a P2P identity on this device.
export interface PictureSource {
  // Why no picture can be uploaded there now; null when one can.
  off: string | null
  // Most bytes of a file that is read.
  maxBytes: number
  // Whether a picture is set.
  has: boolean
  // Keeps the square `crop` of `file`, decoded as `image`. The text of what went wrong, or null.
  upload: (file: File, crop: AvatarCrop, image: ImageBitmap) => Promise<string | null>
  remove: () => Promise<string | null>
}

const STAGE = 256
const PREVIEWS = [128, 64, 32] as const

const draw = (canvas: HTMLCanvasElement | null, image: ImageBitmap, crop: AvatarCrop) => {
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, canvas.width, canvas.height)
}

// Chooses the square of a picture: drag to move, the slider, the wheel or the keys to zoom.
function CropDialog({
  image,
  busy,
  error,
  onUse,
  onClose,
}: {
  image: ImageBitmap
  busy: boolean
  error: string | null
  onUse: (crop: AvatarCrop) => void
  onClose: () => void
}) {
  const { width, height } = image
  const [crop, setCrop] = useState(() => startCrop(width, height))
  const stage = useRef<HTMLCanvasElement>(null)
  const previews = useRef<(HTMLCanvasElement | null)[]>([])
  const drag = useRef<{ x: number; y: number } | null>(null)
  const zoomId = useId()
  const most = maxZoom(width, height)
  useEffect(() => {
    draw(stage.current, image, crop)
    for (const canvas of previews.current) draw(canvas, image, crop)
  }, [image, crop])
  const scale = () => crop.size / (stage.current?.getBoundingClientRect().width || STAGE)
  const zoom = (to: number) => setCrop(c => zoomed(width, height, c, to))
  const step = crop.size / 20
  return (
    <Dialog title="Crop picture" onClose={onClose} top>
      <Stack data-avatar-crop gap="lg" align="center">
        <canvas
          ref={stage}
          width={STAGE * 2}
          height={STAGE * 2}
          tabIndex={0}
          role="img"
          aria-label="Picture crop. Drag or use the arrow keys to move, plus and minus to zoom."
          style={{ width: STAGE, height: STAGE }}
          className="max-w-full cursor-grab touch-none rounded-full bg-surface-container-highest outline-offset-4 active:cursor-grabbing"
          onPointerDown={e => {
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { x: e.clientX, y: e.clientY }
          }}
          onPointerMove={e => {
            const from = drag.current
            if (!from) return
            const by = scale()
            drag.current = { x: e.clientX, y: e.clientY }
            setCrop(c =>
              moved(width, height, c, (from.x - e.clientX) * by, (from.y - e.clientY) * by)
            )
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onWheel={e => zoom(zoomOf(width, height, crop) * Math.exp(-e.deltaY * 0.002))}
          onKeyDown={e => {
            const keys: Record<string, () => void> = {
              ArrowLeft: () => setCrop(c => moved(width, height, c, -step, 0)),
              ArrowRight: () => setCrop(c => moved(width, height, c, step, 0)),
              ArrowUp: () => setCrop(c => moved(width, height, c, 0, -step)),
              ArrowDown: () => setCrop(c => moved(width, height, c, 0, step)),
              '+': () => zoom(zoomOf(width, height, crop) * 1.1),
              '=': () => zoom(zoomOf(width, height, crop) * 1.1),
              '-': () => zoom(zoomOf(width, height, crop) / 1.1),
            }
            const run = keys[e.key]
            if (!run) return
            e.preventDefault()
            run()
          }}
        />
        <Row gap="md" place="w-full">
          <label htmlFor={zoomId} className="text-sm text-on-surface-variant">
            Zoom
          </label>
          <input
            id={zoomId}
            type="range"
            min={1}
            max={most}
            step={0.01}
            disabled={most <= 1}
            value={zoomOf(width, height, crop)}
            onChange={e => zoom(Number(e.target.value))}
            className="min-w-0 flex-1 accent-primary"
          />
        </Row>
        <Row gap="lg" align="end" justify="center" aria-label="Preview" role="group">
          {PREVIEWS.map((side, i) => (
            <Stack key={side} gap="xs" align="center">
              <canvas
                ref={el => {
                  previews.current[i] = el
                }}
                width={side * 2}
                height={side * 2}
                style={{ width: side, height: side }}
                className="rounded-full bg-surface-container-highest"
              />
              <span className="text-xs text-on-surface-variant tabular-nums">{side} px</span>
            </Stack>
          ))}
        </Row>
        <FieldError message={error} />
        <Row gap="sm" justify="end" place="w-full">
          <Button size="md" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="filled" size="md" busy={busy} onClick={() => onUse(crop)}>
            Use picture
          </Button>
        </Row>
      </Stack>
    </Dialog>
  )
}

// The picture part of a profile editor: what shows now, Upload and Remove.
export function PictureField({
  source,
  avatar,
  note,
  disabled = false,
}: {
  source: PictureSource
  // The avatar as it shows now, drawn by the editor.
  avatar: ReactNode
  note?: string
  disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [picked, setPicked] = useState<{ file: File; image: ImageBitmap } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => {
    picked?.image.close()
    setPicked(null)
    setError(null)
  }
  const pick = async (file: File | undefined) => {
    if (!file) return
    const refused = sourceError(file, source.maxBytes)
    if (refused) return setError(refused)
    const image = await createImageBitmap(file).catch(() => null)
    if (!image) return setError("Couldn't read that image")
    const unfit = imageError(image.width, image.height)
    if (unfit) {
      image.close()
      return setError(unfit)
    }
    setError(null)
    setPicked({ file, image })
  }
  const run = async (work: () => Promise<string | null>, done: () => void) => {
    setBusy(true)
    const failed = await work()
    setBusy(false)
    if (failed) setError(failed)
    else done()
  }
  return (
    <Stack data-avatar-picture-field gap="sm">
      <span className="text-sm text-on-surface-variant">Picture</span>
      <Row gap="md" wrap>
        {avatar}
        <input
          ref={input}
          type="file"
          accept={AVATAR_ACCEPT}
          hidden
          onChange={e => {
            void pick(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <Button
          icon={ImageUp}
          disabled={disabled || busy || source.off !== null}
          title={source.off === null ? undefined : notAName(source.off)}
          onClick={() => input.current?.click()}
        >
          {source.has ? 'Change picture' : 'Upload picture'}
        </Button>
        {source.has && (
          <Button
            icon={Trash2}
            disabled={disabled || busy}
            onClick={() => void run(source.remove, () => setError(null))}
          >
            Remove picture
          </Button>
        )}
      </Row>
      <p className="text-xs text-on-surface-variant">
        {source.off ??
          note ??
          'Shown as a circle. Your avatar below shows while it loads and where pictures are hidden.'}
      </p>
      {!picked && <FieldError message={error} />}
      {picked && (
        <CropDialog
          image={picked.image}
          busy={busy}
          error={error}
          onClose={close}
          onUse={crop => void run(() => source.upload(picked.file, crop, picked.image), close)}
        />
      )}
    </Stack>
  )
}
