import { readLocal, writeLocal } from '../../apps/web/app/lib/instances'
import { THEME_KEY, keepTheme, keptTheme, showTheme } from '../../apps/web/app/lib/theme/device'

type Choice = 'auto' | 'dark' | 'light'

// Starlight's key for the choice made on these pages.
const OWN_KEY = 'starlight-theme'

const systemLight = matchMedia('(prefers-color-scheme: light)')

const ownChoice = (): Choice => {
  const kept = readLocal(OWN_KEY)
  return kept === 'light' || kept === 'dark' ? kept : 'auto'
}

// Shows the app's theme while the app on this device keeps one, else the choice made here.
function show() {
  const app = keptTheme()
  const choice = app ?? ownChoice()
  document.documentElement.toggleAttribute('data-app-theme', app !== null)
  for (const select of document.querySelectorAll<HTMLSelectElement>('rchat-theme-select select')) {
    select.value = choice
    const auto = select.querySelector('option[value="auto"]')
    if (auto instanceof HTMLOptionElement) auto.hidden = auto.disabled = app !== null
  }
  showTheme(choice === 'auto' ? (systemLight.matches ? 'light' : 'dark') : choice)
}

function choose(value: string) {
  const choice: Choice = value === 'light' || value === 'dark' ? value : 'auto'
  if (keptTheme() !== null && choice !== 'auto') keepTheme(choice)
  else writeLocal(OWN_KEY, choice === 'auto' ? '' : choice)
  show()
}

let following = false

// Follows the app's theme on this device as it changes, and makes the theme menu set it.
export function followTheme() {
  if (following) return
  following = true
  customElements.define(
    'rchat-theme-select',
    class extends HTMLElement {
      connectedCallback() {
        this.querySelector('select')?.addEventListener('change', e => {
          if (e.currentTarget instanceof HTMLSelectElement) choose(e.currentTarget.value)
        })
      }
    }
  )
  addEventListener('storage', e => {
    if (e.key === THEME_KEY || e.key === OWN_KEY || e.key === null) show()
  })
  systemLight.addEventListener('change', show)
  show()
}
