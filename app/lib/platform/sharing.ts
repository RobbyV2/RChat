// Clipboard, the system share sheet and saving/opening small text files, behind one interface so
// native shells (Tauri, Android, iOS) can plug in their own adapter. The web one is in
// `web_sharing.ts`.

export interface ShareData {
  title?: string
  text?: string
  url?: string
}

export type ShareResult = 'shared' | 'cancelled' | 'failed'

export interface Sharing {
  // Resolves false when the platform refused (no permission, insecure context).
  copyText: (text: string) => Promise<boolean>
  canShare: () => boolean
  share: (data: ShareData) => Promise<ShareResult>
  // Offers `text` as a file download / save dialog; false when the platform can't.
  saveFile: (name: string, text: string, mime: string) => boolean
  // Offers a received file for download / save under `name`, never opening it; false when the
  // platform can't.
  saveBlob: (name: string, blob: Blob) => boolean
  // Lets the user pick a text file; null when cancelled, unreadable or over `maxBytes`.
  openFile: (accept: string, maxBytes: number) => Promise<string | null>
}
