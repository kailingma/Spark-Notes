import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.SPARK_SERVER ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // The client talks to the server on the same origin in production; in dev
    // Vite forwards the API so nothing has to know which mode it's in.
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/plugin-sdk.js': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // No manual chunking for the editor: it is reached through a dynamic
        // `import()`, and Rollup already gives that its own async chunk. Naming
        // it manually pulls it into the entry's static graph, which is exactly
        // what the dynamic import is there to avoid. Code-fence grammars stay
        // as their own on-demand chunks for the same reason.
        manualChunks(id) {
          if (id.includes('node_modules/react')) return 'react';
          return undefined;
        },
      },
    },
  },
});
