import type { Invoke } from './desktop'
import type { Sharing } from './sharing'
import { openBlob } from './web_sharing'

// Files go to disk in pieces this big, so a large one never sits in memory twice.
export const CHUNK_BYTES = 4 * 1024 * 1024

export type SaveResult = 'saved' | 'cancelled' | 'failed'

// Asks where to save, then streams the file there. The page never learns the path.
export const saveTo = async (call: Invoke, name: string, blob: Blob): Promise<SaveResult> => {
  let id: number | null
  try {
    id = await call<number | null>('save_begin', { name })
  } catch {
    return 'failed'
  }
  if (id === null) return 'cancelled'
  const headers = { 'x-save': String(id) }
  try {
    for (let at = 0; at < blob.size; at += CHUNK_BYTES) {
      const bytes = new Uint8Array(await blob.slice(at, at + CHUNK_BYTES).arrayBuffer())
      await call('save_chunk', bytes, { headers })
    }
    await call('save_end', { id, ok: true })
    return 'saved'
  } catch {
    await call('save_end', { id, ok: false }).catch(() => {})
    return 'failed'
  }
}

export const SAVE_FAILED = "Couldn't save the file"

// Clipboard and native save/open dialogs from the desktop shell. There is no share sheet, so
// callers fall back to copying. Saves run in the background; `report` tells the user when one
// fails.
export const desktopSharing = (call: Invoke, report: (message: string) => void): Sharing => {
  const saveBlob = (name: string, blob: Blob) => {
    void saveTo(call, name, blob).then(result => {
      if (result === 'failed') report(SAVE_FAILED)
    })
    return true
  }
  return {
    copyText: text =>
      call('copy_text', { text }).then(
        () => true,
        () => false
      ),
    canShare: () => false,
    share: async () => 'failed',
    saveFile: (name, text, mime) => saveBlob(name, new Blob([text], { type: mime })),
    saveBlob,
    openFile: (accept, maxBytes) =>
      call<string | null>('open_text', { accept, maxBytes }).catch(() => null),
    // The webview's own file picker: the file is streamed from disk, never sent over IPC.
    openBlob,
  }
}
