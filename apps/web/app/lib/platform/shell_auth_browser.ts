import type { AuthBrowser } from './auth_browser'
import { shell } from './desktop'
export const shellAuthBrowser: AuthBrowser = {
  returnTo: 'app',
  navigate: url => shell.openExternal(url),
  popup: async url => {
    await shell.openExternal(url)
    return true
  },
}
