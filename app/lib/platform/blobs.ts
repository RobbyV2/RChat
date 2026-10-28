// Files kept on this device (P2P attachments we host, and P2P files we received), behind one
// interface so native shells can keep them on disk instead. The web one, in IndexedDB, is in
// `web_blobs.ts`.

// A file being written piece by piece, so a large download never has to fit in memory.
export interface BlobWriter {
  // Rejects when the platform has no room left.
  write: (chunk: Uint8Array) => Promise<void>
  // Stores the pieces under the writer's key and returns the whole file with `type`.
  finish: (type: string) => Promise<Blob>
  // Drops everything written so far.
  abort: () => Promise<void>
}

export interface BlobStore {
  // Rejects when the platform has no room or no storage.
  put: (key: string, blob: Blob) => Promise<void>
  get: (key: string) => Promise<Blob | null>
  remove: (key: string) => Promise<void>
  create: (key: string) => Promise<BlobWriter>
  // Removes every file whose key starts with `prefix`, including unfinished ones.
  clear: (prefix: string) => Promise<void>
  // Bytes still free for this app, or null when the platform can't tell.
  room: () => Promise<number | null>
}
