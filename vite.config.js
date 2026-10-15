import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Same proxy paths as vercel.json so dev and production behave the same
    proxy: {
      '/md-api': {
        target: 'https://api.mangadex.org',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/md-api/, ''),
      },
      '/md-img': {
        target: 'https://uploads.mangadex.org',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/md-img/, ''),
      },
    },
  },
})
