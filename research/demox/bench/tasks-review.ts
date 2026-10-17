// T-E · 只读代码审查（模拟真实活：代码审查 / Cloudflare 的多 reviewer + 协调者）
//
// ★ 为什么是这个任务（来自 `真实工作形态调研.md`）★
//
// 1. **它是真实存在的活**：Cloudflare 每次 MR 起最多 7 个专门 reviewer，
//    由一个协调者去重、判级、合并。子 reviewer **只读、且只读自己的分片** ——
//    因为“把 MR 上下文复制七份会让 token 成本乘 7”。
//    → 这是「只读扇出 + 协调者单点仲裁」的真实例。
//
// 2. **它的校验是 O(1) 的**（调研 Q2 的最便宜一类）：软件工程里**有可执行判据**
//    —— 真跑测试就行。这与 T-A（O(n²) 的“两两一致”）形成对照。
//    ★ 这正好能测 G3-3b 的假设：**校验复杂度决定它会不会失控**。
//
// 3. **它天然含“错误可见性”这一轴**：缺陷能不能被局部发现？
//    有的缺陷（除零）一跑就报错；有的（慢查询、资源未释放）静默地传下去。
//
// ★ 判据设计（这里是关键）★
// 不用 LLM 判、不用人评 —— **用 node 真跑**：
//   · 每个缺陷都有一个**可执行的检测器**（跑测试 / 静态检查）；
//   · 产物要求给出「缺陷清单」，判据逐条比对 ground truth。
// 这样“审查做得好不好”就是**机械可判的**，与 demom 的 `judgeText` 同一个哲学。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Doc, Task, TaskVerdict } from "./tasks.ts";

// ─────────────────────────────────────────────────────────────
// 缺陷库：每条缺陷 = 一段带 bug 的代码 + 一个可执行的检测器
// ─────────────────────────────────────────────────────────────

export interface Defect {
  /** 缺陷编号（判据的锚点） */
  id: string;
  /** 在哪个文件里 */
  file: string;
  /** 这段代码的功能（给 agent 看的上下文，不泄露“这里有 bug”） */
  purpose: string;
  /** 带缺陷的源码 */
  code: string;
  /** 人话：缺陷是什么（ground truth，**不给 agent**） */
  what: string;
  /** 缺陷类别：决定了它「能不能被局部发现」 */
  kind: "crash" | "wrong-value" | "silent-leak" | "inconsistent";
  /** 可执行检测器：跑它，返回 true = 缺陷存在 */
  detect: () => boolean;
}

/** 缺陷 A：数组越界（一跑就崩 —— 错误**立即暴露**） */
const defectOffByOne: Defect = {
  id: "D1",
  file: "src/stats.js",
  purpose: "统计数组的最大值",
  code: [
    "export function maxOf(arr) {",
    "  let m = arr[0];",
    "  for (let i = 1; i <= arr.length; i++) {   // 越界：<= 应是 <",
    "    if (arr[i] > m) m = arr[i];",
    "  }",
    "  return m;",
    "}",
  ].join("\n"),
  what: "循环条件用了 i <= arr.length，会读到 undefined；对含负数的数组会返回 NaN 或错值",
  kind: "crash",
  detect: () => {
    const arr = [-5, -3, -9];
    let m = arr[0];
    for (let i = 1; i <= arr.length; i++) if (arr[i] > m) m = arr[i];
    return !(m === -3);
  },
};

/** 缺陷 B：浮点比较（不崩，但**值错**） */
const defectFloatEq: Defect = {
  id: "D2",
  file: "src/money.js",
  purpose: "判断两个金额是否相等",
  code: [
    "export function sameAmount(a, b) {",
    "  return a === b;   // 浮点直接相等比较",
    "}",
  ].join("\n"),
  what: "浮点用 === 比较；0.1 + 0.2 !== 0.3，金额相等判断会出错",
  kind: "wrong-value",
  detect: () => 0.1 + 0.2 !== 0.3,
};

/** 缺陷 C：资源未释放（**静默** —— 不报错、不返回值错，但泄漏） */
const defectLeak: Defect = {
  id: "D3",
  file: "src/reader.js",
  purpose: "读取文件内容",
  code: [
    "import { openSync, readSync } from 'node:fs';",
    "export function readHead(path, n) {",
    "  const fd = openSync(path, 'r');",
    "  const buf = Buffer.alloc(n);",
    "  readSync(fd, buf, 0, n, 0);",
    "  return buf.toString();",
    "  // 忘了 closeSync(fd)",
    "}",
  ].join("\n"),
  what: "打开了文件描述符但没有 closeSync —— 每调用一次泄漏一个 fd，静默，压测时才炸",
  kind: "silent-leak",
  detect: () => true, // 静态可见：源码里没有 closeSync（真检测在下面 judge 里做）
};

/** 缺陷 D：跨文件不一致（**只有看了两份文件才知道** —— 交接面宽的典型） */
const defectInconsistent: Defect = {
  id: "D4",
  file: "src/api.js",
  purpose: "调用下游接口",
  code: [
    "export async function fetchUser(id) {",
    "  const r = await fetch(`/api/v1/users/${id}`);   // v1",
    "  return r.json();",
    "}",
  ].join("\n"),
  what: "调用的是 /api/v1/，但服务端已升级到 /api/v2/（见 src/routes.js）—— 只有同时看两份文件才发现",
  kind: "inconsistent",
  detect: () => true, // 需要跨文件比对
};

/** 配套文件：证明 D4 的“不一致” */
const routesFile = {
  file: "src/routes.js",
  purpose: "服务端路由表",
  code: [
    "export const ROUTES = [",
    "  '/api/v2/users/:id',",
    "  '/api/v2/orders/:id',",
    "];",
  ].join("\n"),
};

/** 无缺陷的对照文件（防止 agent「到处报 bug」就能得分） */
const cleanFiles = [
  { file: "src/util.js", purpose: "字符串工具", code: "export const trim = (s) => s.trim();" },
  { file: "src/const.js", purpose: "常量", code: "export const MAX_RETRY = 3;" },
];

// ─────────────────────────────────────────────────────────────
// 规模扩展（T-E 首扫发现：7 个文件太小 → 12 轮 0 委派）
//
// 手法与 demom 把语料从 14 份扩到 44 份完全一样：**必须超过单 agent 的舒适区**。
// 下面是 16 个额外缺陷，每个带一个**按种类分好的可见性**：
//   crash        —— 一跑就崩（最容易发现）
//   wrong-value  —— 不崩但值错
//   silent-leak  —— 静默，压测才炸
//   inconsistent —— 跨文件才看得出
// ─────────────────────────────────────────────────────────────

function mk(
  id: string,
  file: string,
  purpose: string,
  code: string,
  what: string,
  kind: Defect["kind"],
  kw: string,
): Defect {
  // `__kw` 是关键词正则片段（判据用）。这里它随缺陷定义走，
  // 所以加新缺陷时**不需要手改判据**。
  return { id, file, purpose, code, what, kind, detect: () => true, __kw: kw } as Defect & { __kw: string };
}

/** 语言无关的 JS 缺陷库（不真跑，靠“可机械判定的文本比对”当判据） */
const MORE_DEFECTS: Defect[] = [
  mk("D5", "src/sort.js", "排序工具", "export const byName = (a) => [...a].sort();  // 默认按字符串排，数字会按字典序", "Array.sort() 不传比较器时按字符串排，数字数组会得到 1,10,2 而不是 1,2,10", "wrong-value", "比较器|comparator|字典序|lexicograph|sort"),
  mk("D6", "src/parse.js", "解析整数", "export const toInt = (s) => parseInt(s);  // 没传基数", "parseInt 未传基数，以 0 开头的字符串会被当成八进制（旧引擎）/行为依赖实现", "wrong-value", "基数|radix|parseInt|八进制|octal"),
  mk("D7", "src/async.js", "并发取数", "export async function all(xs) { return xs.map(async (x) => await f(x)); }  // 忘了 Promise.all", "map 里返回 Promise 但没用 Promise.all 包，返回的是 Promise 数组而不是结果", "wrong-value", "Promise\.all|没 await|未等待|pending"),
  mk("D8", "src/cache.js", "带过期的缓存", "const cache = new Map();\nexport function put(k, v) { cache.set(k, v); }  // 没有过期机制", "缓存只写不淘汰，Map 会无限增长（内存泄漏）", "silent-leak", "过期|淘汰|evict|TTL|无限增长|内存"),
  mk("D9", "src/retry.js", "重试", "export async function retry(fn) { for (let i = 0; i < 3; i++) { try { return await fn(); } catch {} } }", "重试耗尽后没有 throw / return，隐式返回 undefined —— 调用方拿到 undefined 而不是错误", "silent-leak", "undefined|没抛|未抛|静默|隐式"),
  mk("D10", "src/listen.js", "事件监听", "export function on(emitter, ev, fn) { emitter.on(ev, fn); }  // 没有返回取消订阅的函数", "注册监听但不返回 unsubscribe，调用方无法取消，会累积监听器（MaxListeners 警告/泄漏）", "silent-leak", "取消|退订|unsubscribe|监听器|累积"),
  mk("D11", "src/conn.js", "连接池", "export function acquire(pool) { return pool.shift(); }  // 没检查空池", "池空时 shift() 返回 undefined，调用方拿到 undefined 连接而不报错", "silent-leak", "空|undefined|边界|检查"),
  mk("D12", "src/copy.js", "深拷贝", "export const clone = (o) => ({ ...o });  // 浅拷贝", "展开运算符只做浅拷贝，嵌套对象仍然共享引用", "wrong-value", "浅拷贝|嵌套|引用|深拷贝|deep"),
  mk("D13", "src/eq.js", "对象比较", "export const eq = (a, b) => a == b;  // 用了 ==", "用了 == 而不是 ===，会导致类型强制转换带来的意外相等", "wrong-value", "===|类型强制|coercion|双等"),
  mk("D14", "src/join.js", "路径拼接", "export const p = (a, b) => a + '/' + b;  // 手拼路径", "手拼路径分隔符，在 Windows 上会出问题；应用 path.join", "inconsistent", "path[.]join|分隔符|平台|Windows"),
  mk("D15", "src/date.js", "日期解析", "export const d = (s) => new Date(s);  // 依赖实现", "new Date(string) 的解析依赖实现，yyyy-mm-dd 与 mm/dd/yyyy 在不同环境结果不同", "inconsistent", "解析|实现依赖|时区|ISO|格式"),
  mk("D16", "src/env.js", "读配置", "export const port = process.env.PORT;  // 没给默认值", "环境变量缺失时是 undefined，拼进 URL 会得到 'localhost:undefined'", "silent-leak", "undefined|默认值|缺失|fallback"),
  mk("D17", "src/num.js", "求和", "export const sum = (xs) => xs.reduce((a, b) => a + b);  // 没给初值", "reduce 没给初值，空数组会抛 TypeError；应传 0", "crash", "初值|initial|空数组|reduce|TypeError"),
  mk("D18", "src/json.js", "安全解析", "export const parse = (s) => JSON.parse(s);  // 没 try", "JSON.parse 没包 try，非法输入会直接抛出而不是返回 null", "crash", "try|捕获|catch|抛|异常"),
  mk("D19", "src/del.js", "删除数组元素", "export function removeFirst(a, x) { const i = a.indexOf(x); a.splice(i, 1); }  // 没检查 -1", "indexOf 返回 -1 时 splice(-1, 1) 会删掉最后一个元素（静默删错数据）", "silent-leak", "-1|indexOf|splice|未找到|检查"),
  mk("D20", "src/div.js", "除法保护", "export const rate = (a, b) => a / b;  // 没检查 b=0", "除零时返回 Infinity / NaN 而不报错，会静默污染下游计算", "silent-leak", "零|0|Infinity|NaN|除"),
];

export const ALL_DEFECTS: Defect[] = [defectOffByOne, defectFloatEq, defectLeak, defectInconsistent, ...MORE_DEFECTS];

// ─────────────────────────────────────────────────────────────
// 造任务
// ─────────────────────────────────────────────────────────────

/**
 * @param defectCount 放几个缺陷（1..20）—— 这是**难度旋钮**，
 *   也是「单 agent 基线能力」的旋钮（调研 Q4 的 45% 饱和点要靠它扫）
 * @param fillerCount 额外放多少份**完全干净**的文件（把规模做大，逼出分工）
 *   —— T-E 首扫的教训：只有 7 个文件时，模型 12 轮 0 委派（自己读完更划算）。
 * @param withClean   是否放无缺陷的对照文件（防“多报就赢”）
 */
export function buildReviewTask(defectCount: number, withClean = true, fillerCount = 0, framing = "precision"): Task {
  if (defectCount < 1 || defectCount > ALL_DEFECTS.length) {
    throw new Error(`defectCount 必须在 1..${ALL_DEFECTS.length}`);
  }
  const defects = ALL_DEFECTS.slice(0, defectCount);

  // 填充文件：干净的，但不比真文件短 —— 否则模型能靠“长度短 = 没问题”作弊
  const fillers = Array.from({ length: fillerCount }, (_, i) => ({
    file: `src/mod${String(i + 1).padStart(2, "0")}.js`,
    purpose: `业务模块 ${i + 1}`,
    code: [
      `export const NAME_${i + 1} = 'module-${i + 1}';`,
      `export function handle_${i + 1}(input) {`,
      `  if (!input) return null;`,
      `  const normalized = String(input).trim().toLowerCase();`,
      `  return { id: normalized, tag: NAME_${i + 1}, len: normalized.length };`,
      `}`,
      `export function validate_${i + 1}(x) {`,
      `  return typeof x === 'object' && x !== null && typeof x.id === 'string';`,
      `}`,
    ].join("\n"),
  }));

  const docs: Doc[] = [
    ...defects.map((d) => ({ id: d.file, title: `${d.file}（${d.purpose}）`, text: d.code })),
    ...(defects.some((d) => d.id === "D4") ? [{ id: routesFile.file, title: `${routesFile.file}（${routesFile.purpose}）`, text: routesFile.code }] : []),
    ...(withClean ? cleanFiles.map((f) => ({ id: f.file, title: `${f.file}（${f.purpose}）`, text: f.code })) : []),
    ...fillers.map((f) => ({ id: f.file, title: `${f.file}（${f.purpose}）`, text: f.code })),
  ].sort((a, b) => a.id.localeCompare(b.id));

  // ★ 干净文件清单必须用**最终的那份** ★
  // 实测踩到：判据收到的是 `cleanFiles.map(...)`（只有 2 个内置的），
  // 填充文件不在里面 → `readings.cleanFilesTotal` 恒为 2，
  // 于是“多报”这一项的判据**对填充文件失效**，而且数据里看不出来。
  const cleanList = [...(withClean ? cleanFiles.map((f) => f.file) : []), ...fillers.map((f) => f.file)];

  const brief = [
    `工作目录的 corpus/ 里有 ${docs.length} 个源文件（每个文件是一份笔记，标题就是它的路径）。`,
    "",
    "你是一名代码审查员。请找出这些代码里**真实的缺陷**，并把结果写成 review.json：",
    "",
    '{"findings": [{"file": "src/a.js", "what": "一句话说明缺陷是什么"}]}',
    "",
    "要求：",
    // ★ ①d 的操纵：这一句在塑造错误方向 ★
    //   形式："只报真实的缺陷，报错了会扣分" → 劝它**保守** → 预期造成**漏报**
    //   形式："尽量别漏，多提几个可疑的没关系" → 劝它**激进** → 预期掉头成**多报**
    //   若两者产出相反的错误方向，则错发「提示塑形错误方向」被证实。
    framing === "recall"
      ? "· **尽量不要漏**。有怀疑的就提，多提几个可疑的不扣分，**漏掉才扣分**。"
      : framing === "neutral"
        ? "· 报你**确信**是真实的缺陷。"
        : "· 只报**真实的**缺陷。报错了（文件里其实没问题）会扣分。",
    "· 一个文件最多报一条。",
    "· 缺陷可能出现在任何文件里，也可能**只有对照两份文件**才能发现。",
    "· 除 review.json 外不要写别的文件。",
  ].join("\n");

  return {
    id: "T-E",
    brief,
    corpus: docs,
    hidden: {
      defects: defects.map((d) => ({ id: d.id, file: d.file, what: d.what, kind: d.kind })),
      clean: cleanList,
      kindMix: kindCount(defects),
    },
    artifact: "review.json",
    judge: judgeReview(defects, cleanList),
    measures:
      "只读扇出 + 协调者单点仲裁（真实活：代码审查）。校验是 **O(1)** 的（可执行判据），" +
      "与 T-A 的 O(n²) 对照 —— 用来测「校验复杂度决定它会不会失控」",
    difficulty: `缺陷数 ${defectCount}；总文件数 ${docs.length}；缺陷种类分布 ${JSON.stringify(kindCount(defects))}`,
  };
}

/** 按可见性统计缺陷种类 —— “错误可见性”是 demox 的一条独立轴 */
function kindCount(defects: Defect[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of defects) out[d.kind] = (out[d.kind] ?? 0) + 1;
  return out;
}

// ─────────────────────────────────────────────────────────────
// 判据：机械比对 finding ↔ ground truth
// ─────────────────────────────────────────────────────────────

function judgeReview(defects: Defect[], cleanFiles: string[]) {
  return (text: string | null, structured: unknown): TaskVerdict => {
    const failed: string[] = [];
    const items: Record<string, boolean> = {};
    const readings: Record<string, number> = {
      findingsReported: 0,
      truePositives: 0,
      falsePositives: 0,
      defectsTotal: defects.length,
      cleanFilesTotal: cleanFiles.length,
    };

    const parsed = parseFindings(text, structured);
    if (!parsed) {
      return { ok: false, items: { produced: false }, failed: ["产物不存在或不是合法 JSON"], readings };
    }
    items.produced = true;

    const wantFiles = new Set(defects.map((d) => d.file));
    const cleanSet = new Set(cleanFiles);
    const reported = parsed.findings.map((f) => ({ file: String(f.file ?? "").replace(/^\.?\//, ""), what: String(f.what ?? "") }));
    readings.findingsReported = reported.length;

    // 命中：报的文件在真缺陷里
    const hit = reported.filter((r) => wantFiles.has(r.file));
    const fp = reported.filter((r) => cleanSet.has(r.file) || !wantFiles.has(r.file));
    readings.truePositives = hit.length;
    readings.falsePositives = fp.length;

    // 去重：同一文件报多次只算一次（判据不比模型写法宽）
    const uniqHit = new Set(hit.map((h) => h.file));

    items.foundAll = uniqHit.size === wantFiles.size;
    if (!items.foundAll) {
      const missed = [...wantFiles].filter((f) => !uniqHit.has(f));
      failed.push(`漏掉的缺陷所在文件：${missed.join("、")}`);
    }

    items.noFalsePositives = fp.length === 0;
    if (!items.noFalsePositives) {
      failed.push(`报了不存在的问题：${fp.map((f) => f.file).join("、")}`);
    }

    // ★ “说清楚是什么问题”这一项用**关键词机械判定**，不用 LLM ★
    // 每条缺陷的关键词存在 `__kw`（管道分隔的正则片段），由缺陷定义自带 ——
    // 这样加新缺陷时**不需要手改判据**（改了也不会忘）。
    // 注意：这是**宽松**判定（命中任一即算说清），比 LLM 判官硬，但也比它宽。
    const kwOf = (d: Defect): RegExp => {
      const raw = (d as Defect & { __kw?: string }).__kw;
      if (raw) return new RegExp(raw, "i");
      // 兜底：按 id 的默认关键词（前四个手写的缺陷走这里）
      const fallback: Record<string, RegExp> = {
        D1: /越界|溢出|out of bound|<= ?arr\.length|undefined|i ?<=/i,
        D2: /浮点|精度|===|相等比较|epsilon|0\.1/i,
        D3: /close|泄漏|leak|fd|文件描述符|资源/i,
        D4: /v1|v2|版本|不一致|version|路由|route/i,
      };
      return fallback[d.id] ?? /./;
    };
    let described = 0;
    for (const d of defects) {
      const r = reported.find((x) => x.file === d.file);
      if (r && kwOf(d).test(r.what)) described++;
    }
    readings.described = described;
    items.describedAll = described === defects.length;
    if (!items.describedAll) {
      const vague = defects.filter((d) => {
        const r = reported.find((x) => x.file === d.file);
        return !r || !kwOf(d).test(r.what);
      });
      failed.push(`说清了 ${described}/${defects.length} 条；没说清的：${vague.map((d) => d.file).join("、")}`);
    }

    readings.precision = reported.length ? readings.truePositives / reported.length : 0;

    return { ok: Object.values(items).every(Boolean), items, failed, readings };
  };
}

/** 从产物里抠出 findings（容错：```json 包裹、前后有解释） */
export function parseFindings(text: string | null, structured: unknown): { findings: { file?: unknown; what?: unknown }[] } | null {
  if (structured && typeof structured === "object") {
    const o = structured as { findings?: unknown };
    if (Array.isArray(o.findings)) return { findings: o.findings as { file?: unknown; what?: unknown }[] };
  }
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const c of [fence?.[1], text].filter(Boolean) as string[]) {
    const s = c.indexOf("{");
    const e = c.lastIndexOf("}");
    if (s < 0 || e <= s) continue;
    try {
      const o = JSON.parse(c.slice(s, e + 1)) as { findings?: unknown };
      if (Array.isArray(o.findings)) return { findings: o.findings as { file?: unknown; what?: unknown }[] };
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 离线自检（零成本）：判据不能有假失败
// ─────────────────────────────────────────────────────────────

export function selfTestReview(): { pass: number; fail: number; log: string[] } {
  const log: string[] = [];
  let pass = 0, fail = 0;
  const t = (name: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else {
      fail++;
      log.push(`✗ ${name}: 得 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
    }
  };

  const task = buildReviewTask(4, true);
  const defects = (task.hidden as { defects: { file: string }[] }).defects;
  const perfect = { findings: defects.map((d) => ({ file: d.file, what: describeFor(d.file) })) };

  t("全对 → ok", task.judge(JSON.stringify(perfect), null).ok, true);
  t("漏一条 → ✗", task.judge(JSON.stringify({ findings: perfect.findings.slice(1) }), null).ok, false);
  t("多报一条 → ✗", task.judge(JSON.stringify({ findings: [...perfect.findings, { file: "src/util.js", what: "有点问题" }] }), null).ok, false);
  t("说得很含糊 → ✗", task.judge(JSON.stringify({ findings: defects.map((d) => ({ file: d.file, what: "这里不太对" })) }), null).ok, false);
  t("```json 包裹 → ok", task.judge("看完了\n```json\n" + JSON.stringify(perfect) + "\n```", null).ok, true);
  t("null → ✗ 有理由", [task.judge(null, null).ok, task.judge(null, null).failed.length > 0], [false, true]);
  t("结构化产物可用", task.judge(null, perfect).ok, true);
  t("无缺陷文件不算数", (task.hidden as { clean: string[] }).clean.length > 0, true);

  // ★ 规模扩展后的回归（T-E 首扫的教训：7 个文件逼不出分工）★
  const big = buildReviewTask(12, true, 20);
  const bigDefs = (big.hidden as { defects: { file: string }[] }).defects;
  t("大任务：12 个缺陷", bigDefs.length, 12);
  t("大任务：总文件数 ≥ 30", big.corpus.length >= 30, true);
  const bigPerfect = { findings: bigDefs.map((d) => ({ file: d.file, what: "问题描述占位" })) };
  t("大任务：全对（说清项除外）", big.judge(JSON.stringify(bigPerfect), null).items.foundAll, true);
  t("大任务：没说清 → ✗", big.judge(JSON.stringify(bigPerfect), null).ok, false);
  // ★ 回归：填充文件必须算进“干净文件”（否则多报判据对它们失效）
  t("大任务：干净文件清单含填充", (big.hidden as { clean: string[] }).clean.length >= 20, true);
  t(
    "大任务：报填充文件 → 误报",
    big.judge(JSON.stringify({ findings: [...bigPerfect.findings, { file: "src/mod01.js", what: "有问题" }] }), null).readings.falsePositives,
    1,
  );

  return { pass, fail, log };
}

function describeFor(file: string): string {
  if (file.includes("stats")) return "循环条件越界，i <= arr.length 会读到 undefined";
  if (file.includes("money")) return "浮点数直接用 === 比较精度有问题";
  if (file.includes("reader")) return "打开文件描述符后没有 close，会泄漏 fd";
  if (file.includes("api")) return "调用的是 /api/v1/，但 routes.js 里只有 /api/v2/，版本不一致";
  return "未知";
}
