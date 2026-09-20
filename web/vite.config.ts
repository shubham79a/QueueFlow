import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // shadcn/ui generates components that import from "@/...". The alias has to exist
    // here for the bundler AND in tsconfig.app.json for the typechecker — setting only
    // one gives a build that half works.
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
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
