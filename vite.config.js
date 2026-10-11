import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue2';
import path from 'path';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));

export default defineConfig({
  plugins: [vue()],
  base: './',
  root: path.resolve(__dirname),
  publicDir: 'public',
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
    'import.meta.env.VITE_HOMEPAGE': JSON.stringify(pkg.homepage),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('element-ui')) return 'element-ui';
            if (id.includes('echarts')) return 'echarts';
            if (id.includes('@xterm')) return 'xterm';
            if (id.includes('novnc')) return 'novnc';
            if (id.includes('ironrdp')) return 'ironrdp';
            if (id.includes('marked')) return 'marked';
          }
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
