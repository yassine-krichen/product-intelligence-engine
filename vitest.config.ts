import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Mirrors the `@/*` -> `./src/*` alias declared in tsconfig.json. Vitest does
// not read tsconfig `paths` on its own, so it is re-declared here.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
  },
});
