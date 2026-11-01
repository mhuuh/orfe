import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// A second wall behind the markdown allowlist: the page can only talk to itself and OpenRouter.
// Style attributes need 'unsafe-inline'. Add the relay's address to connect-src in Plan 2.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:", // Vite inlines the smallest font subsets
  "connect-src 'self' https://openrouter.ai",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export default defineConfig({
  base: '/orfe/',
  plugins: [
    react(),
    {
      // Build only: the dev server needs inline scripts and a websocket.
      name: 'orfe-csp',
      apply: 'build',
      transformIndexHtml: () => [
        { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
      ],
    },
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
