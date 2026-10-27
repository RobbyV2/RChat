export const retrySeconds = (header: string | null, text = '', now = Date.now()): number | null => {
  const raw = header?.trim()
  if (raw) {
    if (/^\d+$/.test(raw)) return Math.max(1, Number(raw))
    const at = Date.parse(raw)
    if (!Number.isNaN(at)) return Math.max(1, Math.ceil((at - now) / 1000))
  }
  const hint = /wait (?:for )?(\d+)\s*(?:s\b|sec|second)/i.exec(text)
  return hint ? Math.max(1, Number(hint[1])) : null
}

export const tooManyText = (seconds: number | null) =>
  seconds === null
    ? 'Too many attempts — try again in a few seconds'
    : `Too many attempts — try again in ${seconds} s`
