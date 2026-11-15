import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  // Render builds set RENDER=true: mark the build as the public demo unless VITE_PUBLIC_DEMO says otherwise.
  define: process.env.RENDER && !process.env.VITE_PUBLIC_DEMO ? { "import.meta.env.VITE_PUBLIC_DEMO": JSON.stringify("1") } : {},
  envDir: "..", // only VITE_* variables are exposed to the browser
  server: { port: 5173, strictPort: true, proxy: { "/api": "http://localhost:8787" } },
  worker: { format: "es" },
  // One three.js copy for R3F, drei and the Matterport web component (which needs three 0.184).
  resolve: { dedupe: ["three", "react", "react-dom"] },
});
