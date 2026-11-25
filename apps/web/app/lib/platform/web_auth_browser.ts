import type { AuthBrowser } from './auth_browser'
export const webAuthBrowser: AuthBrowser = {
  returnTo: 'web',
  navigate: url => window.location.assign(url),
  popup: url => window.open(url, 'rchat-sso', 'popup,width=520,height=720') ?? false,
}
