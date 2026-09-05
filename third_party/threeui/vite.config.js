import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/",
  plugins: [react()],
  optimizeDeps: {
    include: ["three128", "three165"],
  },
  build: {
    sourcemap: false,
  },
});
