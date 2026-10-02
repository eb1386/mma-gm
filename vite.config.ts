import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  // Absolute asset paths. A relative base made a deep link such as /fighter/123 request its script
  // and stylesheet from /fighter/assets/, which the history fallback answers with index.html, so
  // refreshing or sharing any page below the root loaded an unstyled, broken game. The iPhone app
  // serves from the root of its own origin, so it needs the same.
  base: '/',
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1400,
  },
  server: {
    port: 5177,
    strictPort: false,
  },
});
