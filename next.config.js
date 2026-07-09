const staticExport = process.env.STATIC_EXPORT === 'true'
const appMode = process.env.APP_MODE || 'full'

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: staticExport ? 'export' : 'standalone',
  trailingSlash: true,
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
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
