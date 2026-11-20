import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 900, rollupOptions: { output: { manualChunks: { three: ['three'] } } } },
  test: { include: ['tests/*.test.ts'] },
});
