import { builtinModules } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import tsconfigPaths from 'vite-tsconfig-paths';

import pkg from './package.json';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const externalDeps = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`), // for Node.js 18+ compatibility
  ...Object.keys(pkg.dependencies || {}),
  /\.node$/, // native addons
];

export default defineConfig({
  plugins: [
    tsconfigPaths(),
    // Copy i18n locale files to dist so they're available at runtime
    // In the bundle, __dirname resolves to dist/, so locales must be at dist/locales/
    viteStaticCopy({
      targets: [
        {
          src: 'src/i18n/locales/*.json',
          dest: 'locales',
        },
      ],
    }),
  ],
  build: {
    target: 'node23',
    // Connection settings are also consumed directly by Node/Sequelize CLI.
    commonjsOptions: { include: [/node_modules/, /config[\\/]db[\\/]/] },
    outDir: 'dist',
    lib: {
      entry: {
        app: path.resolve(__dirname, 'src/app.ts'),
        'import-plaid-connection': path.resolve(__dirname, 'src/scripts/import-plaid-connection.ts'),
      },
      formats: ['cjs'],
    },
    rollupOptions: {
      external: externalDeps,
      output: {
        entryFileNames: '[name].js',
        // Fixes default import issues
        // Initially was added to resolve issues with `p-queue` import
        // Without this setting the "import PQueue from 'p-queue';" works incorrectly
        // in the way that PQueue doesn't become a constructor, but an object that contains
        // .default field. TS wasn't able to spot this, so it caused errors in production
        interop: 'auto',
      },
    },
    sourcemap: true,
    emptyOutDir: true,
    // Disable minifaction to keep logs readable and prevent Sequelize class-based
    // relations being corrupted by obfuscation
    minify: false,
  },
});
