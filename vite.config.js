import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    define: {
      __LAW_API_OC__: JSON.stringify(env.LAW_API_OC ?? ''),
      __KSKILL_PROXY_BASE_URL__: JSON.stringify(env.KSKILL_PROXY_BASE_URL ?? ''),
    },
    server: {
      proxy: {
        '/DRF': {
          target: 'https://www.law.go.kr',
          changeOrigin: true,
          secure: true,
        },
        '/kskill': {
          target: env.KSKILL_PROXY_BASE_URL || 'https://k-skill-proxy.nomadamas.org',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/kskill/, ''),
        },
      },
    },
  };
});
