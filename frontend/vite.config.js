import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const normalizeBase = (basePath = '/') => {
  const trimmed = basePath.trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
};

export default defineConfig(() => ({
  base: normalizeBase(process.env.VITE_APP_BASE),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
}));
