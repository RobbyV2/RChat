import './globals.css'
import { Inter } from 'next/font/google'
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter'
import Script from 'next/script'
import { NotificationProvider } from './lib/notifications'

const inter = Inter({ subsets: ['latin'], display: 'swap', preload: true })

export const metadata = {
  title: 'RChat',
  description: 'Chat platform',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <Script id="console-suppressor" strategy="beforeInteractive">
          {`
            (function() {
              const shouldSuppress = (msg) => {
                return typeof msg === 'string' && (
                  msg.includes('[HMR]') ||
                  msg.includes('Download the React DevTools') ||
                  msg.includes('better development experience') ||
                  msg.includes('react-devtools') ||
                  msg.includes('WebSocket connected') ||
                  msg.includes('WebSocket disconnected') ||
                  msg.includes('Reconnecting in')
                );
              };
              const origLog = console.log;
              const origWarn = console.warn;
              const origInfo = console.info;
              console.log = function(...args) { if (!shouldSuppress(args[0])) origLog.apply(console, args); };
              console.warn = function(...args) { if (!shouldSuppress(args[0])) origWarn.apply(console, args); };
              console.info = function(...args) { if (!shouldSuppress(args[0])) origInfo.apply(console, args); };
            })();
          `}
        </Script>
      </head>
      <body className={inter.className} suppressHydrationWarning>
        <AppRouterCacheProvider>
          <NotificationProvider>{children}</NotificationProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  )
}
