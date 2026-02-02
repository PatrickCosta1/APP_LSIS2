import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
    plugins: [
        react(),
        VitePWA({
            registerType: 'autoUpdate',
            injectRegister: 'auto',
            manifest: {
                name: 'Kynex',
                short_name: 'Kynex',
                description: 'Kynex — consumos, equipamentos e poupança',
                start_url: '/',
                scope: '/',
                display: 'standalone',
                background_color: '#12181F',
                theme_color: '#12181F',
                icons: [
                    {
                        src: '/pwa-icon.svg',
                        sizes: 'any',
                        type: 'image/svg+xml'
                    }
                ]
            },
            workbox: {
                navigateFallback: '/index.html',
                globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}']
            }
        })
    ],
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: './src/setupTests.ts'
    }
});
