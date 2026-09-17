import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 4173,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2020',
    sourcemap: true,
    outDir: 'dist',
    rollupOptions: {
      output: {
        entryFileNames: 'game.js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
});
