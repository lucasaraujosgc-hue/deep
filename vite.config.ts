import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['send.virgulacontabil.com.br', 'localhost', '127.0.0.1'],
  },
  build: {
    outDir: 'dist',
  },
});
