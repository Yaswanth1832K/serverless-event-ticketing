import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Local development: `npm run dev` serves the app and forwards /api/* to the deployed API, so the
// browser sees one origin and no CORS setup is needed. The target comes from .env.local, which
// `node scripts/frontend-config.mjs --dev` writes from the stack outputs.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    // amazon-cognito-identity-js expects a Node-style global
    define: { global: 'globalThis' },
    server: {
      port: 5173,
      proxy: env.API_PROXY_TARGET
        ? { '/api': { target: env.API_PROXY_TARGET, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, '') } }
        : undefined,
    },
    build: { target: 'es2020', sourcemap: false },
  };
});
