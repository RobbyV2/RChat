// What the app calls an instance: its own name, or its host when the name tells nothing (unset,
// the default) or another instance in view has the same one.

export const DEFAULT_INSTANCE_NAME = 'RChat'

export const instanceLabel = (
  info: { name?: string | null } | null | undefined,
  host: string,
  others: readonly { name: string; host: string }[] = []
): string => {
  const name = info?.name?.trim() ?? ''
  if (!name || name === DEFAULT_INSTANCE_NAME) return host || name
  const key = name.toLowerCase()
  const shared = others.some(o => o.host !== host && o.name.trim().toLowerCase() === key)
  return shared ? host || name : name
}

// Text cut where it names the instance, so the name can be hidden in streamer mode.
export const labelParts = (text: string, label: string): { text: string; label: boolean }[] => {
  if (!label) return text ? [{ text, label: false }] : []
  return text
    .split(label)
    .flatMap((part, i) => [
      ...(i > 0 ? [{ text: label, label: true }] : []),
      ...(part ? [{ text: part, label: false }] : []),
    ])
}
