import path from 'node:path';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    TanStackRouterVite({}),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        short_name: 'watchlist',
        name: 'watchlist',
        start_url: '/last-list',
        display_override: ['standalone'],
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#0d0713',
        background_color: '#0d0713',
        icons: [
          { src: '/favicon.ico', type: 'image/x-icon', sizes: '16x16 32x32' },
          { src: '/icon-192.png', type: 'image/png', sizes: '192x192' },
          { src: '/icon-512.png', type: 'image/png', sizes: '512x512' },
          { src: '/icon-192-maskable.png', type: 'image/png', sizes: '192x192', purpose: 'maskable' },
          { src: '/icon-512-maskable.png', type: 'image/png', sizes: '512x512', purpose: 'maskable' },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': {
        target: 'ws://localhost:8787',
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },
});
