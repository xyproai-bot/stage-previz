import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Code-split：把 three / react / 應用程式碼拆成獨立 chunk
        // 大 chunk 警告解掉 + 利於 cache（three 很少改 → cdn cache 能命中）
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('three')) return 'three';
            if (id.includes('react-router')) return 'react-router';
            if (id.includes('react')) return 'react';
            if (id.includes('zustand')) return 'zustand';
            return 'vendor';
          }
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
});
