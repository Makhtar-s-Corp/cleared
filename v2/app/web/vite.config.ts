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
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here('.'),
  publicDir: here('../public'),
  base: '/',
  plugins: [tailwindcss()],
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
  },
});
