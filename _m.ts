import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const lab = process.argv[2] ?? "research/labfirst/hunt";
const sinceMin = Number(process.argv[3] ?? 240);
const since = Date.now() - sinceMin * 60_000;

const files: { f: string; dir: string }[] = [];
for (const dir of ["outbox", "work"]) {
  try {
    for (const f of readdirSync(join(lab, dir))) {
      if (!f.endsWith(".md")) continue;
      const p = join(lab, dir, f);
      try { if (statSync(p).mtimeMs >= since) files.push({ f, dir }); } catch {}
    }
  } catch {}
}
const txt = files.map((x) => ({ ...x, t: readFileSync(join(lab, x.dir, x.f), "utf8") }));

const has = (re: RegExp) => txt.filter((x) => re.test(x.t));
const WEB = /https?:\/\/(?!localhost|127\.)|arxiv\.org|doi\.org|nature\.com|sciencemag|springer|acm\.org|ieee/i;
const DISC = /信息论|熵|社会选择|Arrow|kappa|κ|SPC|控制图|贝叶斯|博弈|格兰杰|马尔可夫|方差分析|ANOVA|Fisher|p ?值|效应量|Fleiss|Cochran|香农/;
const WEBTOOL = /web_search|fetch_content|source_check|get_search_content/;
const CONJ = /猜想[：:]/;
const KILL = /判死|算被推翻|推翻条件|若.*则.*假/;
const DEVICE = /npx tsx|node [\w./-]+\.(mjs|ts|js)|--self-test/;
const CTRL = /对照臂|控制臂|对照组|基线臂|placebo|安慰剂/;
const PHEN = /现象[：:]|与预期不符|反常|意外地|没料到/;
const MODEL = /模型[：:]|机制是|可以解释成|抽象成/;
const EXIT = /结局[：:]|结局列/;

const pct = (n: number) => `${n}/${txt.length}（${Math.round((n / Math.max(txt.length, 1)) * 100)}%）`;
console.log(`★ 窗口 ${sinceMin} 分钟 · 产物 ${txt.length} 份（outbox ${files.filter(f=>f.dir==="outbox").length} · work ${files.filter(f=>f.dir==="work").length}）`);
console.log(`  外部材料（URL/arXiv/期刊）: ${pct(has(WEB).length)}`);
console.log(`  跨学科概念            : ${pct(has(DISC).length)}`);
console.log(`  提到 web 工具         : ${pct(has(WEBTOOL).length)}`);
console.log(`  猜想：标记            : ${pct(has(CONJ).length)}`);
console.log(`  判死条件              : ${pct(has(KILL).length)}`);
console.log(`  可跑装置              : ${pct(has(DEVICE).length)}`);
console.log(`  对照臂                : ${pct(has(CTRL).length)}`);
console.log(`  现象（与预期不符）    : ${pct(has(PHEN).length)}`);
console.log(`  模型/机制             : ${pct(has(MODEL).length)}`);
console.log(`  结局                  : ${pct(has(EXIT).length)}`);
const three = txt.filter((x)=>CONJ.test(x.t)&&DEVICE.test(x.t)&&CTRL.test(x.t));
console.log(`  ★★ 三段齐（猜想+装置+对照）: ${three.length}${three.length?` → ${three.map(x=>x.f.slice(0,40)).join(" | ")}`:""}`);
const web = has(WEB);
console.log(`  ★★ 带外部链接的产物: ${web.map(x=>x.f.slice(0,44)).slice(0,6).join(" | ") || "无"}`);
