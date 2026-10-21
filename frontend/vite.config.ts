import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Vite forwards anything under /api to the backend (same origin, so cookies just work).
    proxy: { '/api': 'http://localhost:4000' },
  },
});