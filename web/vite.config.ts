import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In dev, Vite serves the UI here and Express serves the API on :4000. Forwarding
    // /api means the browser only talks to one origin — no CORS — and the same relative
    // URLs keep working in production, where Express serves both.
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
})
