import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync, mkdirSync } from 'node:fs'

// Every build gets an id; the app polls /version.json and offers a reload when the server's id differs.
const BUILD_ID = Date.now().toString(36)

export default defineConfig({
  plugins: [react(), {
    name: 'version-json',
    closeBundle() { mkdirSync('dist', { recursive: true }); writeFileSync('dist/version.json', JSON.stringify({ build: BUILD_ID })) },
  }],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.API_URL || 'http://127.0.0.1:8000', changeOrigin: true } },
  },
})
