import { satteri } from '@astrojs/markdown-satteri'
import starlight from '@astrojs/starlight'
import { defineConfig, passthroughImageService } from 'astro/config'
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi'

export default defineConfig({
  base: '/docs',
  image: { service: passthroughImageService() },
  build: { inlineStylesheets: 'never' },
  devToolbar: { enabled: false },
  markdown: { processor: satteri({ features: { smartPunctuation: false } }) },
  integrations: [
    starlight({
      title: 'RChat',
      favicon: '/favicon.png',
      customCss: ['./src/styles/theme.css', './src/styles/custom.css'],
      components: {
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
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
        {
          label: 'Reference',
          items: [{ autogenerate: { directory: 'reference' } }, ...openAPISidebarGroups],
        },
      ],
    }),
  ],
})
