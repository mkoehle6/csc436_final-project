import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * Stamps the build's git commit into index.html as
 * <meta name="app-commit" content="…">, so the deployed frontend version can be
 * checked from outside (curl the page). Render sets RENDER_GIT_COMMIT during
 * builds; GIT_COMMIT works elsewhere; local builds say "dev".
 */
function commitMeta(): Plugin {
  const commit = process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? 'dev'
  return {
    name: 'commit-meta',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'app-commit', content: commit }, injectTo: 'head' }],
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), commitMeta()],
})
