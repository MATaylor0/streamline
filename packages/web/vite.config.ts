import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.STREAMLINE_API ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': target, '/mcp': target, '/healthz': target },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
