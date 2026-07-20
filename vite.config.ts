import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:7000",
      "/hooks": "http://127.0.0.1:7000"
    }
  },
  build: {
    outDir: "dist/web"
  }
});
