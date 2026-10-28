// System notifications and the app badge, behind one interface so native shells (Tauri on
// desktop, Android, iOS) can plug in their own adapter. The web one is in `web_notifications.ts`.

export type Permission = 'granted' | 'denied' | 'default' | 'unsupported'

export interface NoticeOptions {
  title: string
  body: string
  // Notices with the same tag replace each other (one per channel or DM).
  tag: string
  icon?: string
  // Alert again when replacing a notice with the same tag.
  renotify?: boolean
  onClick: () => void
}

export interface NoticeHandle {
  close: () => void
}

export interface Notifier {
  supported: () => boolean
  permission: () => Permission
  requestPermission: () => Promise<Permission>
  // Null when the platform refused to show it.
  show: (opts: NoticeOptions) => NoticeHandle | null
  // Calls back when the permission changes outside the app (e.g. revoked in site settings).
  onPermissionChange: (cb: (p: Permission) => void) => () => void
  // Unseen notification count on the tab title / app icon; 0 clears it.
  setBadge: (count: number) => void
}

export const permissionOf = (raw: unknown): Permission =>
  raw === 'granted' || raw === 'denied' || raw === 'default' ? raw : 'default'
