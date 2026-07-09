import type { Metadata, Viewport } from 'next'
import './globals.css'
import PwaRegister from './components/pwa_register'

export const metadata: Metadata = {
  title: 'RChat',
  description: 'Anonymous Material chat',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/rchat_r.png', type: 'image/png' },
    ],
    apple: '/icons/apple_touch_icon.png',
  },
  appleWebApp: { capable: true, title: 'RChat' },
}

export const viewport: Viewport = {
  themeColor: '#141218',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{document.documentElement.dataset.theme=localStorage.getItem('rchat_theme')||'dark'}catch(e){}",
          }}
        />
        <PwaRegister />
        {children}
      </body>
    </html>
  )
}
