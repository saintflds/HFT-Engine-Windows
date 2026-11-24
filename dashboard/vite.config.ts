import { fileURLToPath } from 'node:url';
import { defineConfig } from "vite";
import { sierraPlugin } from "./server/sierra.mjs";
import { enginePlugin } from "./server/engine.mjs";

import {sessionsPlugin} from './server/sessions.mjs';
export default defineConfig({
  plugins: [{ name: 'project-location', configureServer(server) {
      server.middlewares.use('/api/project-location', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ root: fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '') }));
      });
    } },sessionsPlugin(),enginePlugin(), sierraPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    // Native file notifications can fail with EBUSY on the portable exFAT drive.
    watch: { usePolling: true, interval: 500, ignored: ['**/tests/**'] },
  },
  build: {
    rollupOptions: { input: { replay: "index.html", mnq: "mnq.html" } },
    target: "es2022",
    assetsInlineLimit: 0,
  },
});
