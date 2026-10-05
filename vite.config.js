import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/v1": {
        target: "http://10.0.10.231:9090",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/v1/, "/api/v1"),
      },

      "/grafana-blog-rss": {
        target: "https://grafana.com",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/grafana-blog-rss/, ""),
      },
    },
  },
});
