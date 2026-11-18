import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: `${root}/dist`, emptyOutDir: true },
  server: {
    host: '0.0.0.0',
    port: 3005,
    strictPort: true,
    hmr: { host: process.env.VITE_HMR_HOST ?? 'localhost', clientPort: Number(process.env.VITE_HMR_PORT ?? 3005) },
    watch: process.env.VITE_USE_POLLING === 'true' ? { usePolling: true, interval: 100 } : undefined,
    proxy: { '/api': { target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8081', changeOrigin: true } }
  }
});
