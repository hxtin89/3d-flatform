import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import cesium from 'vite-plugin-cesium';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is opt-in (npm run dev:https): WebGPU needs a secure context, so testing
// WebGPU on a phone over LAN requires https://<ip>:5173 (self-signed cert — accept
// the one-time warning on the device). Plain http stays the default for the Mac.
const useHttps = process.env.VITE_HTTPS === '1';

export default defineConfig({
  plugins: [cesium(), ...(useHttps ? [basicSsl()] : [])],
  server: {
    port: 5177,
    // Fail instead of silently moving to 5178 when the port is taken (usually a
    // dev server left running from an earlier session). The MapTiler key is
    // restricted to whitelisted origins, and 5177 is the only one this project
    // uses — on any other port the basemap just 403s, which reads as a broken
    // key rather than a wrong port. A hard "port is already in use" is far
    // easier to act on. To run a second instance deliberately, pass a port that
    // is also whitelisted: npm run dev -- --port 4177
    strictPort: true,
    host: true, // listen on all interfaces + print LAN IPs for phone testing
    open: '/threejs-test.html', // auto-open the Three.js/WebGPU map app
    proxy: {
      // Proxy tile requests to the local tile server
      '/tiles': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tiles/, ''),
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
