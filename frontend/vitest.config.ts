import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Frontend tests run in a simulated browser (jsdom). Kept separate from
// vite.config.ts so the production build config stays unchanged.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx'],
  },
})
