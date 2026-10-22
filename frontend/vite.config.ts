import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The browser talks only to localhost:5173. Vite forwards anything under /api to the backend.
    // Same origin = no CORS headaches, and the refresh cookie works exactly like it will in production.
    proxy: { '/api': 'http://localhost:4000' },
  },
});