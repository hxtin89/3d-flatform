import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import cesium from 'vite-plugin-cesium';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// HTTPS is opt-in (npm run dev:https): WebGPU needs a secure context, so testing
// WebGPU on a phone over LAN requires https://<ip>:5173 (self-signed cert — accept
// the one-time warning on the device). Plain http stays the default for the Mac.
const useHttps = process.env.VITE_HTTPS === '1';

export default defineConfig({
  plugins: [cesium(), svelte(), ...(useHttps ? [basicSsl()] : [])],
  // @wi/ui ships real .svelte sources in its dist. Vite's dep pre-bundler is
  // esbuild, which cannot compile those -- when it pre-bundles the package, a
  // component's entire source file can end up served as a stylesheet, so its
  // scoped CSS silently never applies. The symptom is subtle and looks like a
  // layout bug rather than a build one: position/z-index rules go missing, so
  // absolutely-positioned children collapse into normal flow. Excluding the
  // package routes those files through vite-plugin-svelte, which is what
  // actually knows how to compile them.
  optimizeDeps: { exclude: ['@wi/ui'] },
  server: {
    port: 5177,
    host: true, // listen on all interfaces + print LAN IPs for phone testing
    open: '/threejs-test.html', // auto-open the Three.js/WebGPU map app
    proxy: {
      // Proxy tile requests to the local tile server
      '/tiles': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tiles/, ''),
      },
      // The MapTiler key is domain-restricted, so every raster tile a dev server
      // on localhost requests comes back 403 (with a placeholder PNG body) and the
      // basemap stays empty. Strip the Referer here — the key answers 200 without
      // one. Dev only; the production build talks to api.maptiler.com directly.
      '/maptiler': {
        target: 'https://api.maptiler.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/maptiler/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('referer')
            proxyReq.removeHeader('origin')
          })
        },
      },
    },
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      input: {
        // Legacy Cesium viewer + Three.js/WebGPU map app + full Cesium variant
        main: resolve(__dirname, 'index.html'),
        'threejs-test': resolve(__dirname, 'threejs-test.html'),
        'cesium-test': resolve(__dirname, 'cesium-test.html'),
      },
    },
  },
});
