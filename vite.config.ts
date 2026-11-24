import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

/**
 * Refuse un build de développement. Vite 8 en produit un dès qu'il lit `NODE_ENV=development` dans un
 * fichier d'environnement du projet : l'application livrée se croit alors en développement (React de
 * développement, aucune recherche automatique de mise à jour), sans aucun message. C'est arrivé avec
 * les versions 0.5.0 et 0.5.1. `npm run build` force `NODE_ENV=production`, ce qui l'emporte.
 */
function requireProductionBuild(): Plugin {
  return {
    name: 'require-production-build',
    apply: 'build',
    configResolved(config) {
      if (!config.isProduction) {
        throw new Error(
          `Build de développement refusé (NODE_ENV=${process.env.NODE_ENV}). ` +
            'Passez par `npm run build`, qui force NODE_ENV=production, ou retirez NODE_ENV du fichier d’environnement.'
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), requireProductionBuild()],
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
