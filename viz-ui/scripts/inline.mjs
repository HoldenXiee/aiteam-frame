import { readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * 把 vite 产出的 dist 合成为**单文件** index.html。
 *
 * ★★★ 为什么要内联：设计者要"双击就能用"。file:// 下浏览器按 CORS 拒绝
 *   `<script type="module" src="./assets/x.js">`（实测白屏）。内联后零外部引用、零服务。
 *
 * ★★★ 两个必须同时做对的细节（都踩过，且都是**静默白屏**）：
 *   ① 用**函数形式** replace —— 替换串里的 `$&` / `` $` `` / `$1` 会被 String.replace
 *      当特殊序列解释，打包后的 JS 里到处是 `$` ⇒ 会把原标签又插回去；
 *   ② 内联后的脚本必须挪到 `</body>` 前 —— 原来 `type="module"` 是延迟执行，
 *      变成普通 `<script>` 后会**同步执行**，那时 `<div id="root">` 还没解析
 *      ⇒ React 报 #299（Target container is not a DOM element），页面全白。
 */
const dist = join(process.cwd(), "dist");
const assets = join(dist, "assets");
let html = readFileSync(join(dist, "index.html"), "utf8");

const js = readdirSync(assets).filter((f) => f.endsWith(".js"));
const css = readdirSync(assets).filter((f) => f.endsWith(".css"));

for (const f of css) {
  const code = readFileSync(join(assets, f), "utf8");
  html = html.replace(new RegExp(`<link[^>]*assets/${f}[^>]*>`), () => `<style>\n${code}\n</style>`);
}

let bodyScript = "";
for (const f of js) {
  bodyScript += `<script>\n${readFileSync(join(assets, f), "utf8")}\n</script>\n`;
  html = html.replace(new RegExp(`<script[^>]*assets/${f}[^>]*></script>`), () => "");
}
html = html.replace("</body>", () => `${bodyScript}</body>`);

// ★ 只查"标签还在引用"（包内 JS 自带 "/assets/" 这类字符串，不是失败）
if (/<(script|link)[^>]+assets\//.test(html)) {
  console.error("★ 内联失败：index.html 里还有标签引用 assets/ —— 别静默通过");
  process.exit(1);
}
// ★ 包内 JS 若含 `</script>` 字面量，内联会提前截断脚本（同样是静默坏掉），必须拦
if ((html.match(/<\/script>/g) ?? []).length !== 1) {
  console.error("★ 内联后出现多个 </script>：包内可能有 `</script>` 字面量，会截断脚本");
  process.exit(1);
}
// ★ 脚本必须在 </body> 之前、<div id="root"> 之后（否则 React 找不到容器）
if (html.indexOf("<script>") < html.indexOf('id="root"')) {
  console.error('★ 内联的脚本跑到了 <div id="root"> 之前 —— 会白屏（React #299）');
  process.exit(1);
}

writeFileSync(join(dist, "index.html"), html, "utf8");
rmSync(assets, { recursive: true, force: true });
console.log(`★ 单文件已生成：dist/index.html（${(html.length / 1024).toFixed(0)}KB，零外部引用）`);
