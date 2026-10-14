import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
  // 模型壓縮 worker 用到的套件：開發時一開始就先處理好（不然第一次壓縮時 Vite 才發現、整頁重新載入）
  optimizeDeps: {
    include: [
      '@gltf-transform/core',
      '@gltf-transform/extensions',
      'draco3dgltf/draco_encoder_gltf_nodejs.js',
      'draco3dgltf/draco_decoder_gltf_nodejs.js',
    ],
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
            // 模型解壓縮器（Draco / meshopt）只有壓縮過的模型才用到 → 自己一個小 chunk，用到才下載（不放進 three）
            if (/[\\/]three[\\/]examples[\\/]jsm[\\/](loaders[\\/]DRACOLoader|libs[\\/]meshopt_decoder)/.test(id)) return undefined;
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
