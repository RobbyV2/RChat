import type { MetadataRoute } from 'next'

export const dynamic = 'force-static'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'RChat',
    short_name: 'RChat',
    description: 'Anonymous Material chat',
    start_url: '/',
    display: 'standalone',
    theme_color: '#141218',
    background_color: '#141218',
    icons: [
      { src: '/icons/icon_192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon_512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon_maskable_512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
