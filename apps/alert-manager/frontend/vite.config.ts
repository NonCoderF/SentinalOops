import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: `${root}/dist`, emptyOutDir: true },
  server: { port: 3005, proxy: { '/api': 'http://localhost:8081' } }
});
