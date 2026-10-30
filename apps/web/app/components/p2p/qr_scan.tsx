'use client'

import { useEffect, useRef, useState } from 'react'
import { Camera, ImageUp } from 'lucide-react'
import { scanner } from '../../lib/platform'
import { textBtn } from '../ui'

const FRAME_MS = 250
const MAX_SIDE = 1024

const pixels = (source: CanvasImageSource, w: number, h: number) => {
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

// Scans a QR code with the camera, or from a picture. Pasting stays the fallback in the dialogs
// that use this.
export function QrScan({ onCode, label }: { onCode: (text: string) => void; label: string }) {
  const video = useRef<HTMLVideoElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const done = useRef(onCode)
  const mounted = useRef(true)
  useEffect(() => {
    done.current = onCode
  })
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!stream) return
    const el = video.current
    if (el) {
      el.srcObject = stream
      void el.play().catch(() => {})
    }
    let busy = false
    const timer = window.setInterval(() => {
      const v = video.current
      if (busy || !v || v.readyState < 2) return
      const image = pixels(v, v.videoWidth, v.videoHeight)
      if (!image) return
      busy = true
      void scanner()
        .decode(image)
        .then(text => {
          if (!text) return
          setStream(null)
          done.current(text)
        })
        .finally(() => {
          busy = false
        })
    }, FRAME_MS)
    return () => {
      window.clearInterval(timer)
      stream.getTracks().forEach(t => t.stop())
    }
  }, [stream])

  const start = async () => {
    setNote(null)
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      })
      // Closed while the browser asked for the camera: let it go at once.
      if (!mounted.current) return media.getTracks().forEach(t => t.stop())
      setStream(media)
    } catch {
      setNote('No camera available. Pick a picture or paste the code instead.')
    }
  }

  const fromFile = async (f: File | undefined) => {
    if (!f) return
    setNote(null)
    try {
      const bmp = await createImageBitmap(f)
      const image = pixels(bmp, bmp.width, bmp.height)
      bmp.close()
      const text = image ? await scanner().decode(image) : null
      if (text) onCode(text)
      else setNote('No QR code found in that picture')
    } catch {
      setNote("Couldn't read that picture")
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {stream ? (
        <div className="flex flex-col items-center gap-2">
          <video
            ref={video}
            muted
            playsInline
            aria-label={label}
            className="aspect-square w-full max-w-72 rounded-2xl bg-black object-cover"
          />
          <button type="button" onClick={() => setStream(null)} className={textBtn}>
            Stop camera
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {scanner().canUseCamera() && (
            <button
              type="button"
              onClick={() => void start()}
              className={`${textBtn} flex items-center gap-1.5`}
            >
              <Camera size={16} />
              Scan with camera
            </button>
          )}
          <button
            type="button"
            onClick={() => file.current?.click()}
            className={`${textBtn} flex items-center gap-1.5`}
          >
            <ImageUp size={16} />
            Scan a picture
          </button>
          <input
            ref={file}
            type="file"
            accept="image/*"
            aria-label="Picture of a QR code"
            className="hidden"
            onChange={e => {
              void fromFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>
      )}
      {note && <p className="text-xs text-on-surface-variant">{note}</p>}
    </div>
  )
}
