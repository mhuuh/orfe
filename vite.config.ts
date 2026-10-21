import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/orfe/',
  plugins: [
    react(),
    VitePWA({
      // 'prompt': a new version waits; main.tsx applies it only when idle (it reloads the page).
      registerType: 'prompt',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'ORFE',
        short_name: 'ORFE',
        start_url: '/orfe/',
        scope: '/orfe/',
        display: 'standalone',
        background_color: '#0e0e0f',
        theme_color: '#0e0e0f',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        navigateFallback: '/orfe/index.html',
        // Fonts are bundled for offline use. woff too: geist-mono's symbols2 subset ships only as woff.
        // Icons are added from includeAssets and the manifest, so they are not globbed again.
        globPatterns: ['**/*.{js,css,html,woff2,woff}'],
      },
    }),
  ],
})
