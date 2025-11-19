export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}

export function pluralize(count: number, singular: string, plural?: string): string {
  if (count === 1) return `${count} ${singular}`
  return `${count} ${plural || singular + 's'}`
}

export function handleApiError(
  err: any,
  operation: string,
  showError: (msg: string) => void
): void {
  console.error(`Failed to ${operation}:`, err)
  const message = err?.data?.message || err?.message || `Failed to ${operation}`
  showError(message)
}
