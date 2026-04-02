import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    // Proxy your API during local dev (same-origin avoids CORS). Uncomment and set target:
    // proxy: {
    //   '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    //   '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
    // },
  },
  build: {
    target: 'esnext',
  },
});
