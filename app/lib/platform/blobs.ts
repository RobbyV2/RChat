// Files kept on this device (P2P attachments we host), behind one interface so native shells can
// keep them on disk instead. The web one, in IndexedDB, is in `web_blobs.ts`.

export interface BlobStore {
  // Rejects when the platform has no room or no storage.
  put: (key: string, blob: Blob) => Promise<void>
  get: (key: string) => Promise<Blob | null>
  remove: (key: string) => Promise<void>
}
