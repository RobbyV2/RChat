const IMG_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' }

// A pasted image under a name that says what it is.
export const namePasted = (f: File) =>
  new File([f], `pasted.${IMG_EXT[f.type] ?? f.type.split('/')[1] ?? 'png'}`, { type: f.type })
