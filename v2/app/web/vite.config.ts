// The app's front end, built by Vite (npm run build): the owner's one
// exception to "no build" (decisions log, 2026-10-22). The service and the
// app's server stay TypeScript that Node runs with its types stripped; only
// the React code under web/ is bundled, into app/dist/, which the server
// serves (app/src/server.ts reads dist/.vite/manifest.json for the file
// names). app/public/ (fonts, icons, manifest, service worker, theme
// script) is copied as it is.
//
// CopilotKit runs without its runtime and without Copilot Cloud: the page
// uses only its headless React entries, so the web inspector (which loads
// Google Fonts) and the prebuilt chat (Lucide icons, its own stylesheet)
// are replaced by an empty module and never reach the bundle. Telemetry's
// switches are set here too, although nothing bundled reads them.
/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Hallmark's stamp (styles/app.css, lane j6-ui-hallmark) is the first line of the built sheet, as its linter reads
// it; Tailwind writes its licence banner first, so the two trade places. Both are kept.
const stampFirst = (): Plugin => ({
  name: 'hallmark-stamp-first',
  generateBundle(_options, bundle) {
    for (const asset of Object.values(bundle)) {
      if (asset.type !== 'asset' || !asset.fileName.endsWith('.css') || typeof asset.source !== 'string') continue;
      const banner = /^\/\*! tailwindcss [^*]*\*\/\s*/.exec(asset.source);
      const rest = banner ? asset.source.slice(banner[0].length) : '';
      const stamp = /^\/\*! Hallmark[^]*?\*\/\s*(?:\/\*! Hallmark[^]*?\*\/\s*)*/.exec(rest);
      // The minifier keeps a comment only as /*! */; the stamp is written back as the plain comment Hallmark reads.
      if (banner && stamp) asset.source = `${stamp[0].replaceAll('/*! Hallmark', '/* Hallmark')}${banner[0]}${rest.slice(stamp[0].length)}`;
    }
  },
});

export default defineConfig({
  root: here('.'),
  publicDir: here('../public'),
  base: '/',
  plugins: [tailwindcss(), stampFirst()],
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${here('.')}/` },
      { find: /^@copilotkit\/web-inspector$/, replacement: here('copilot/empty.ts') },
    ],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env.COPILOTKIT_TELEMETRY_DISABLED': JSON.stringify('true'),
    'process.env.DO_NOT_TRACK': JSON.stringify('1'),
    'process.env.SCARF_ANALYTICS': JSON.stringify('false'),
  },
  oxc: { jsx: { runtime: 'automatic' } },
  // The components' tests (npm test runs them after node --test): rendered
  // to HTML under Node, as the tests of the HTML renderers did before.
  test: {
    include: ['test/**/*.test.tsx'],
    environment: 'node',
    css: false,
  },
  build: {
    outDir: here('../dist'),
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    // One entry: the server writes the page around it.
    rollupOptions: {
      input: here('main.tsx'),
      // Radix marks its modules "use client" for React Server Components, which this page does not use.
      onwarn(warning, warn) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); },
    },
    // CopilotKit's headless core and AG-UI's client (with zod) are one chunk, loaded by the session and lead screens only.
    chunkSizeWarningLimit: 700,
  },
});
