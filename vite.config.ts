import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 1430,
    strictPort: true,
    watch: {
      // Le dossier Rust (et son target/ de compilation) ne concerne pas Vite.
      ignored: ['**/src-tauri/**'],
    },
  },
});
