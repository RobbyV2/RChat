// Opening the docs: a new tab on the web, a window of their own in the desktop app, and the app's
// own view on a phone, where the docs show a way back.

export interface DocsViewer {
  open: (url: string) => Promise<void>
}

export const webDocs: DocsViewer = {
  open: async url => {
    window.open(url, '_blank', 'noopener')
  },
}

export const mobileDocs: DocsViewer = {
  open: async url => {
    window.location.assign(url)
  },
}

// The window the docs opened in, while it is open: opening again brings it to the front.
let shown: { setFocus: () => Promise<void> } | null = null

export const desktopDocs: DocsViewer = {
  open: async url => {
    if (shown) return shown.setFocus()
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const win = new WebviewWindow('docs', { url, title: 'Docs', width: 1100, height: 800 })
    shown = win
    const closed = () => {
      shown = null
    }
    void win.once('tauri://destroyed', closed)
    void win.once('tauri://error', closed)
  },
}
