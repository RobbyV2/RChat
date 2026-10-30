// Reading QR codes from the camera or a picture, behind one interface so native shells can use
// their own scanner. The web one is in `web_qr_scanner.ts`.

export interface QrScanner {
  // Whether a camera can be asked for at all.
  canUseCamera: () => boolean
  // The text of a QR code in this frame or picture, or null when there is none.
  decode: (image: ImageData) => Promise<string | null>
}
