import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';

// `npm run dev` serves over HTTPS on your LAN so phones can open the camera.
export default defineConfig({
  base: './',
  plugins: [basicSsl()],
  resolve: { alias: [{ find: /^@tensorflow\/tfjs$/, replacement: fileURLToPath(new URL('./src/ar/tf-lite.js', import.meta.url)) }] },
  server: { host: true, https: true },
  preview: { host: true, https: true },
  build: { target: 'es2020', outDir: 'dist', assetsInlineLimit: 0, chunkSizeWarningLimit: 4000, copyPublicDir: true },
});
