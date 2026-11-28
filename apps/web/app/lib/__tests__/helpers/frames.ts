import type { Read } from '../../p2p/strike'

// What a frame reader answered: the frame, 'unknown', or null where it earned a strike.
export const frameOf = <T>(read: Read<T>): T | 'unknown' | null =>
  'v' in read ? read.v : 'unknown' in read ? 'unknown' : null

// The frame a reader answered, or null.
export const known = <T>(read: Read<T>): T | null => ('v' in read ? read.v : null)
