export interface AuthBrowser {
  returnTo: 'web' | 'app'
  navigate(url: string): void | Promise<void>
  popup(url: string): boolean | Promise<boolean>
}
