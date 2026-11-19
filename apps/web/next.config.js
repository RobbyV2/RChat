import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const staticExport = process.env.STATIC_EXPORT === 'true'
const appMode = process.env.APP_MODE || 'full'

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_FIELD_NOTES_DIGEST: createHash('sha256')
      .update(readFileSync(new URL('./public/app-examples/field-notes.json', import.meta.url)))
      .digest('hex'),
  },
  output: staticExport ? 'export' : 'standalone',
  trailingSlash: true,
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  agentRules: false,
  images: {
    unoptimized: staticExport,
  },
}

if (!staticExport && appMode === 'api-only') {
  const serverPort = process.env.SERVER_PORT || '3000'
  const serverHost = process.env.HOST || 'localhost'
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || `http://${serverHost}:${serverPort}`
  nextConfig.rewrites = async () => ({
    beforeFiles: [],
    afterFiles: [],
    fallback: [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }],
  })
}

export default nextConfig
