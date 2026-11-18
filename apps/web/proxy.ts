import { NextRequest, NextResponse } from 'next/server'

// Only the widget document can opt into framing. Request its policy from the instance that
// serves this web process, including when the public host is behind a reverse proxy.
export async function proxy(request: NextRequest) {
  const response = NextResponse.next()
  let ancestors = "'none'"
  if (['/widget/', '/widget'].includes(request.nextUrl.pathname)) {
    const id = request.nextUrl.searchParams.get('id') ?? ''
    if (/^[a-f0-9]{32}$/.test(id)) {
      const api =
        process.env.NEXT_PUBLIC_API_URL || `http://127.0.0.1:${process.env.SERVER_PORT || '3000'}`
      try {
        const result = await fetch(new URL(`/api/v1/widgets/${id}/framing`, api), {
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(3000),
        })
        if (result.ok) ancestors = await result.json()
      } catch {
        /* A missing policy keeps the document private. */
      }
    }
    response.headers.set('Referrer-Policy', 'no-referrer')
    response.headers.set('Cache-Control', 'private, no-store')
  }
  response.headers.set('Content-Security-Policy', `frame-ancestors ${ancestors}`)
  return response
}

export const config = { matcher: ['/((?!_next/static|_next/image|_next/webpack-hmr).*)'] }
