import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import cesium from 'vite-plugin-cesium';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';

// HTTPS is opt-in (npm run dev:https): WebGPU needs a secure context, so testing
// WebGPU on a phone over LAN requires https://<ip>:5173 (self-signed cert — accept
// the one-time warning on the device). Plain http stays the default for the Mac.
const useHttps = process.env.VITE_HTTPS === '1';

export default defineConfig({
  plugins: [react(), cesium(), ...(useHttps ? [basicSsl()] : [])],
  server: {
    port: 5177,
    strictPort: true, // a silent port change can invalidate the MapTiler origin allowlist
    host: true, // listen on all interfaces + print LAN IPs for phone testing
    open: '/r3f.html', // auto-open the Three.js/WebGPU map app
    proxy: {
      // Proxy tile requests to the local tile server
      '/tiles': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tiles/, ''),
      },
      // Preserve the real development origin (including its port) for the
      // localhost key's allowlist. Production requests MapTiler directly.
      '/maptiler': {
        target: 'https://api.maptiler.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/maptiler/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const protocol = (req.socket as any).encrypted ? 'https' : 'http'
            const origin = `${protocol}://${req.headers.host}`
            proxyReq.setHeader('origin', origin)
            proxyReq.setHeader('referer', `${origin}/`)
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
        main: resolve(__dirname, 'index.html'),
        'r3f': resolve(__dirname, 'r3f.html'),
        'cesium-test': resolve(__dirname, 'cesium-test.html')
      },
    },
  },
});
