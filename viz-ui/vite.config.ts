import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ★★★ 目标：**双击 dist/index.html 就能用**（file://）。
//   file:// 下浏览器按 CORS 拒绝 `<script type="module" src="./assets/x.js">`
//   （实测白屏，控制台报 "Cross origin requests are only supported for http/https"）。
//   ⇒ 打成 **IIFE**，再由 scripts/inline.mjs 把 JS/CSS 内联进 index.html，做到"一个文件、零依赖、零服务"。
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: { output: { format: "iife", inlineDynamicImports: true } },
  },
});
