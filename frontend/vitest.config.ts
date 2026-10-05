import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts: vitest 2 bundles its own Vite 5, so sharing one config (and the
// React plugin) between Vite 6 and vitest makes the types disagree. esbuild handles the JSX here.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  define: { global: 'globalThis' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    globals: true,
  },
});
