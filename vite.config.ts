import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    // Relative asset paths, not absolute. The default '/' hard-codes the domain
    // root, so a build copied into a subdirectory - 77builders.com/drill/ - asks
    // for /assets/main.js instead of /drill/assets/main.js, gets a 404, and
    // renders an empty page. './' keeps the same build working at the root, in
    // any subdirectory, and inside the Capacitor WebView.
    base: './',
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        // Two entry points: the field app (index.html) and the administrator's
        // dashboard (admin.html). They share the Supabase client, the row
        // mappers and reports.ts rather than duplicating them.
        input: {
          main: path.resolve(__dirname, 'index.html'),
          admin: path.resolve(__dirname, 'admin.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
