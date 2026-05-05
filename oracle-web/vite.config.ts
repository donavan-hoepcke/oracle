/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    exclude: ['**/node_modules/**', '.chrome-profile/**', '.chrome-debug-profile/**'],
  },
  server: {
    port: 5173,
    // The Chrome debug profile lives inside this repo so the Playwright
    // scraper can attach. Chrome rewrites extension files constantly, which
    // would otherwise trigger full-page reloads several times a second.
    watch: {
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/.chrome-profile/**',
        '**/.chrome-debug-profile/**',
        '**/.playwright-state/**',
      ],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // Needed for /api/raw/stream WS upgrades (e.g. useOpsHealth hook).
        ws: true,
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
})
