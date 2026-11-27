// The app's modules read `process.env` the way the Next.js build sets it. These pages are not
// built by Next.js, so the values come from the page at run time (see `detect`).
const g = globalThis as { process?: { env: Record<string, string | undefined> } }
g.process ??= { env: {} }
export const env = g.process.env
