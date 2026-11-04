import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(__dirname, '../shared') } },
  server: {
    port: 5173,
    // Loopback only; pass --host deliberately to expose it. Vite >= 5.4.12 also rejects foreign Host headers and
    // cross-origin requests by default, which earlier 5.4.x releases did not.
    host: 'localhost',
    // Only the client and the shared calc module may be served; never the repo root (backend/data holds signing keys).
    fs: { allow: ['.', '../shared'], deny: ['.env', '.env.*', '*.{crt,pem}', '**/.secret', '**/.django_secret'] },
    proxy: { '/api': 'http://localhost:4000' },
  },
  build: { chunkSizeWarningLimit: 1500 },
});
