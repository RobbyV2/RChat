import { useMemo } from 'react'
import { Check, Copy } from 'lucide-react'
import { encode } from 'uqr'
import { sharing } from '../lib/platform'
import { useCopied } from '../lib/use_copied'
import { IconButton } from './controls'

const QR_SIZE = {
  sm: 'size-36 shrink-0',
  md: 'h-auto w-full max-w-56',
  lg: 'h-auto w-full max-w-72',
}

// Dark modules on white with a 4-module quiet zone in both themes, so all scanners can read it.
export function QrCode({
  text,
  label,
  size = 'md',
}: {
  text: string
  label: string
  // `sm` is a fixed 9 rem square that sits beside text; `md` and `lg` fill their place up to 14
  // and 18 rem.
  size?: 'sm' | 'md' | 'lg'
}) {
  const qr = useMemo(() => encode(text, { ecc: 'M', border: 4 }), [text])
  const path = useMemo(() => {
    let d = ''
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`
      })
    )
    return d
  }, [qr])
  return (
    <svg
      role="img"
      aria-label={label}
      data-qr={text}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      className={`block rounded-lg ${QR_SIZE[size]}`}
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  )
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, flashCopied] = useCopied()
  return (
    <IconButton
      icon={copied ? Check : Copy}
      label={label}
      tooltip={copied ? 'Copied' : label}
      size="sm"
      onClick={() =>
        void sharing()
          .copyText(text)
          .then(ok => ok && flashCopied())
      }
    />
  )
}
