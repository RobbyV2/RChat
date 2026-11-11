// An API answer that is an HTML page was written by something in front of the instance (a
// challenge proxy checking browsers), not by the instance.

interface Answer {
  url: string
  headers: { get(name: string): string | null }
}

export const isProxyPage = (response: Answer): boolean => {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (type !== 'text/html') return false
  try {
    return /(^|\/)api(\/|$)/.test(new URL(response.url, 'http://instance.invalid').pathname)
  } catch {
    return false
  }
}
