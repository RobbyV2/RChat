import type { QrScanner } from './qr_scanner'

interface Detector {
  detect: (image: ImageData) => Promise<{ rawValue: string }[]>
}

type DetectorCtor = new (opts: { formats: string[] }) => Detector

let detector: Detector | null | undefined

// BarcodeDetector where the browser has it (Chromium on Android and macOS, Safari 17+);
// otherwise jsQR, loaded only when a code is first scanned.
const native = async (): Promise<Detector | null> => {
  if (detector !== undefined) return detector
  const Ctor = (
    globalThis as {
      BarcodeDetector?: DetectorCtor & { getSupportedFormats?: () => Promise<string[]> }
    }
  ).BarcodeDetector
  try {
    const formats = (await Ctor?.getSupportedFormats?.()) ?? []
    detector = Ctor && formats.includes('qr_code') ? new Ctor({ formats: ['qr_code'] }) : null
  } catch {
    detector = null
  }
  return detector
}

export const webQrScanner: QrScanner = {
  canUseCamera: () =>
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function',
  decode: async image => {
    const d = await native()
    if (d) {
      try {
        const hits = await d.detect(image)
        if (hits[0]?.rawValue) return hits[0].rawValue
      } catch {
        // Fall through to jsQR.
      }
    }
    const { default: jsQR } = await import('jsqr')
    return (
      jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' })?.data ??
      null
    )
  },
}
