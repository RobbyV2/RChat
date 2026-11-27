import { satteri } from '@astrojs/markdown-satteri'
import starlight from '@astrojs/starlight'
import { defineConfig, passthroughImageService } from 'astro/config'
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi'

export default defineConfig({
  base: '/docs',
  image: { service: passthroughImageService() },
  build: { inlineStylesheets: 'never' },
  devToolbar: { enabled: false },
  vite: { oxc: { jsx: { runtime: 'automatic', importSource: 'react' } } },
  markdown: { processor: satteri({ features: { smartPunctuation: false } }) },
  integrations: [
    starlight({
      title: 'RChat',
      favicon: '/favicon.png',
      customCss: ['./src/styles/theme.css', './src/styles/custom.css'],
      components: {
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
        SocialIcons: './src/components/SocialIcons.astro',
      },
      expressiveCode: { styleOverrides: { borderRadius: 'var(--radius-lg)' } },
      plugins: [
        starlightOpenAPI([
          {
            base: 'reference/api',
            schema: './generated/openapi.json',
            sidebar: { label: 'REST API', operations: { badges: true } },
          },
        ]),
      ],
      sidebar: [
        { label: 'Start', link: '/' },
        { label: 'Using RChat', items: [{ autogenerate: { directory: 'use' } }] },
        { label: 'Running an instance', items: [{ autogenerate: { directory: 'run' } }] },
        { label: 'API', items: [{ autogenerate: { directory: 'api' } }] },
        { label: 'P2P protocol', items: [{ autogenerate: { directory: 'p2p' } }] },
        { label: 'Contributing', items: [{ autogenerate: { directory: 'contribute' } }] },
        {
          label: 'Reference',
          items: [{ autogenerate: { directory: 'reference' } }, ...openAPISidebarGroups],
        },
      ],
    }),
  ],
})
