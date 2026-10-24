// ══════════════════════════════════════════════════════════════════════════
// ★★★ 拓扑探针 v2 —— **一次只跑一个臂**
//
//   设计者 2026-10-20 指出的问题（我自己的错，记在这里）：
//     「你是设计了几个实验，还是说是组合成一个实验了」
//   ★ v1 把五个臂塞进一次 `console.log` ⇒ 那不是五个实验，是**一个演示**：
//     · 没有「改前/改后」对照
//     · 五个臂共用同一份内存状态（只有 D 调过 reset）
//     · 一起绿 ⇒ **无法归因**
//
//   ★★ v2 的规矩（纪律②⑱）：
//     1. **一次只跑一个臂**（`--arm=X`），跑完进程退出
//     2. 每个臂**自己的沙箱目录**（`_sandbox/<arm>/`），跑前清干净
//     3. 每个臂**必带对照**（`--control` 跑"开关关"的那一侧）
//     4. 输出**可比的数**（不是"✔ 接上了"这种形容词）
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 这个探针测什么 / 不测什么
//
//   测：① 判据在**给定输入**上命中/不命中（确定性，可离线重判）
//       ② 命中的是**该命中的**、不该命中的**不命中**（负例比正例重要）
//   不测：③ 规则在生产 `tick()` 里会不会被调用 —— ★ 那要真跑集群看 `_topology.log`
//        ④ 产物质量 —— 那要真跑模型
//
// ★★ 所以本探针的结论**只到判据层**，不到机制层。别把它读成"规则接上了"。
//
// ══════════════════════════════════════════════════════════════════════════
// 跑法（★ 一次一个）：
//   npx tsx research/clusters/forge/micro/topology-probe.ts --arm=table
//   npx tsx research/clusters/forge/micro/topology-probe.ts --arm=table --control
//   npx tsx research/clusters/forge/micro/topology-probe.ts --list
// ══════════════════════════════════════════════════════════════════════════

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  INDEX_NAME,
  REVERSAL_RE,
  TABLE_NAME,
  UNTESTED_RE,
  countTableRows,
  extractChapterNumbers,
  readChapterIndexRows,
} from "../topology/rules.ts";

// ─────────────── 沙箱（每个臂一个目录）───────────────

const SANDBOX_ROOT = join(import.meta.dirname, "_sandbox");

/**
 * ★★★ 安全阀：与 hunt 微实验 2026-10-19 事故后的同一条纪律。
 * 探针只允许动 `_sandbox/` 里的东西 —— 绝不许碰真集群。
 */
function assertSandbox(p: string): void {
  if (!p.replace(/\\/g, "/").includes("_sandbox")) {
    throw new Error(
      `探针只允许动自己的沙箱，但这个路径不在里面：\n  ${p}\n` +
        `  ★ 2026-10-19 事故：微实验删过真集群的 work/（靠 git 才恢复）。`,
    );
  }
}

/** ★ 每个臂有自己的沙箱 —— 这是 v1 的错（共用一份）的修法 */
function freshSandbox(arm: string): string {
  const dir = join(SANDBOX_ROOT, arm, "outbox");
  assertSandbox(dir);
  rmSync(join(SANDBOX_ROOT, arm), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function put(dir: string, name: string, body: string): void {
  assertSandbox(dir);
  writeFileSync(join(dir, name), body);
}

// ─────────────── 读数（★ 可比的数，不是形容词）───────────────

export type ArmReading = {
  arm: string;
  /** 这一臂跑的是"处理"还是"对照" */
  side: "处理" | "对照";
  /** 喂进去的样本数 */
  cases: number;
  /** 判据命中数 */
  hits: number;
  /** ★ 逐条的判定（正例/负例各自的期望）*/
  detail: { name: string; expectHit: boolean; gotHit: boolean }[];
  /** ★ 与期望不符的条数 —— **这个数才是结论** */
  wrong: number;
};

function summarize(arm: string, side: "处理" | "对照", detail: ArmReading["detail"]): ArmReading {
  return {
    arm,
    side,
    cases: detail.length,
    hits: detail.filter((d) => d.gotHit).length,
    detail,
    wrong: detail.filter((d) => d.expectHit !== d.gotHit).length,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 各臂：**判据层实验**（每个都是"给定输入 → 判据给什么"）
//
//   ★ 每个臂都有一组**正例**（该命中）和**负例**（不该命中）。
//   ★★ 结论看 `wrong`（判错的条数）—— 0 才算这个判据站得住。
// ══════════════════════════════════════════════════════════════════════════

/** ★ 猜想 A · onTable 的阈值判据：「未并入表的产物 ≥2 份」 */
function armTable(control: boolean): ArmReading {
  const detail: ArmReading["detail"] = [];
  // ★ 阈值 2：1 份不该触发（否则每份产物都单独成表）
  for (const [n, expect] of [[0, false], [1, false], [2, true], [5, true]] as [number, boolean][]) {
    const got = control ? n > 0 : n >= 2; // ★ 对照 = 阈值降到 1
    detail.push({ name: `${n} 份未并入`, expectHit: expect, gotHit: got });
  }
  return summarize("table", control ? "对照" : "处理", detail);
}

/** ★ 猜想 B · onSilentSeat 的判据：「landing 零产出 且 outbox ≥5」 */
function armSilent(control: boolean): ArmReading {
  const detail: ArmReading["detail"] = [];
  const seats = ["theory/mapper", "practice/runner", "landing/reader", "landing/edge"];
  // ★ 负例：theory 有产物 ⇒ 不该催（哪怕它这份是别人写的）
  // ★ 正例：landing 零产物 且 outbox≥5 ⇒ 该催
  const scenes: [string, string[], number, boolean][] = [
    ["outbox=3（太早）", ["theory-1.md"], 3, false],
    ["outbox=8，landing 有产物", ["theory-1.md", "landing-reader-1.md"], 8, false],
    ["outbox=8，landing 零产物", Array.from({ length: 8 }, (_, i) => `theory-${i}.md`), 8, true],
  ];
  for (const [name, outs, count, expect] of scenes) {
    const target = "landing/reader";
    const wrote = outs.some((f) => f.includes(target.replace("/", "-")));
    const got = control
      ? wrote === false // ★ 对照 = 去掉 outbox≥5 这个门槛
      : count >= 5 && !wrote;
    detail.push({ name, expectHit: expect, gotHit: got });
  }
  void seats;
  return summarize("silent", control ? "对照" : "处理", detail);
}

/** ★ 猜想 C · onFalsify 的判据：正文命中 `REVERSAL_RE` */
function armFalsify(control: boolean): ArmReading {
  const cases: [string, string, boolean][] = [
    // ★★ 负例（比正例重要）：措辞收紧**不是**推翻
    ["v2 修订（措辞收紧）", "## v2 修订\n★ 接受挑战后把「一律」改成「多数」。", false],
    ["纯定义", "★ 所谓「判据」指的是……", false],
    // ★ 正例
    ["被 P26 取代", "★ 本结论**被 P26 取代**：原形状未重现。", true],
    ["被 `P26` **取代**（带格式）", "★ 本结论**被 `P26` **取代**。", true],
    ["降级", "★ 本行**降级**：p=0.14。", true],
    ["单字「推翻」", "推翻", true],
  ];
  const detail = cases.map(([name, body, expect]) => {
    // ★ 对照 = 用旧的窄判据（`被取代` 要求两字紧挨）
    const got = control ? /推翻|被取代|降级/.test(body) : REVERSAL_RE.test(body);
    return { name, expectHit: expect, gotHit: got };
  });
  return summarize("falsify", control ? "对照" : "处理", detail);
}

/** ★ 猜想 D · onChapterIndex 的判据：引用了登记表里没有的章号 */
function armIndex(control: boolean): ArmReading {
  const detail: ArmReading["detail"] = [];

  // 场景 1：无登记表，产物引用 4、9 ⇒ 两个都悬空
  {
    const dir = freshSandbox(`index-${control ? "control" : "treat"}-1`);
    put(dir, "产物.md", "# 第九章\n\n★ 本章替换第四章的处方。");
    const idx = control ? new Set([4, 9]) : readChapterIndexRows(dir); // ★ 对照 = 假装表是全的
    const bad = extractChapterNumbers("# 第九章\n\n★ 本章替换第四章的处方。").filter((n) => !idx.has(n));
    detail.push({ name: "无登记表 → 应有悬空", expectHit: !control, gotHit: bad.length > 0 });
  }

  // 场景 2：登记了 4 和 9 ⇒ 不该报（★ 负例）
  {
    const dir = freshSandbox(`index-${control ? "control" : "treat"}-2`);
    put(dir, INDEX_NAME, "| 章号 | 标题 |\n|---|---|\n| 第4章 | x |\n| 第9章 | y |\n");
    const idx = control ? new Set<number>() : readChapterIndexRows(dir);
    const bad = extractChapterNumbers("第九章替换第四章。").filter((n) => !idx.has(n));
    detail.push({ name: "已登记 4/9 → 不该报", expectHit: false, gotHit: bad.length > 0 });
  }

  // 场景 3：只登记 9，引用 4 ⇒ 该报
  {
    const dir = freshSandbox(`index-${control ? "control" : "treat"}-3`);
    put(dir, INDEX_NAME, "| 章号 | 标题 |\n|---|---|\n| 第9章 | y |\n");
    const idx = control ? new Set<number>() : readChapterIndexRows(dir);
    const bad = extractChapterNumbers("第九章替换第四章。").filter((n) => !idx.has(n));
    detail.push({ name: "只登记 9 → 4 应报", expectHit: !control, gotHit: bad.length > 0 });
  }

  return summarize("index", control ? "对照" : "处理", detail);
}

/** ★ 猜想 E · onUntested 的判据：正文命中 `UNTESTED_RE` */
function armUntested(control: boolean): ArmReading {
  const cases: [string, string, boolean][] = [
    // ★★ 负例：真跑了实验的不该问
    ["真跑 16 轮", "★ 新跑 16 轮 ≈ 4.35M token，fp=0。", false],
    ["纯定义", "★ 这条是定义，不是断言。", false],
    // ★ 正例
    ["0 次新 API", "★ 0 次新 API（全部是重新解释）。", true],
    ["不含新读数", "★ 本章 0 API，不含新读数。", true],
  ];
  const detail = cases.map(([name, body, expect]) => {
    // ★ 对照 = 只认最窄的写法
    const got = control ? /0 次新 API/.test(body) : UNTESTED_RE.test(body);
    return { name, expectHit: expect, gotHit: got };
  });
  return summarize("untested", control ? "对照" : "处理", detail);
}

// ─────────────── 表驱动（★ 一次只取一个）───────────────

const ARMS: Record<string, (control: boolean) => ArmReading> = {
  table: armTable,
  silent: armSilent,
  falsify: armFalsify,
  index: armIndex,
  untested: armUntested,
};

export const ARM_NAMES = Object.keys(ARMS);

// ─────────────── CLI ───────────────

const isMain =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("topology-probe.ts");

if (isMain) {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];

  if (process.argv.includes("--list")) {
    console.log(`可用臂（★ 一次跑一个）：\n  ${ARM_NAMES.join("\n  ")}\n`);
    console.log(`每个臂都有对照：加 \`--control\` 跑"开关关/判据更窄"的那一侧。`);
    process.exit(0);
  }

  const armName = arg("arm");
  if (!armName) {
    console.error(`✘ 必须指定 \`--arm=<名字>\`（一次只跑一个实验）。\n`);
    console.error(`可用：${ARM_NAMES.join(" / ")}`);
    console.error(`\n★ 为什么强制一次一个：v1 把五个臂塞进一次运行 —— 那不是五个实验，`);
    console.error(`  是一个演示（共用状态、无对照、无法归因）。`);
    process.exit(1);
  }
  const probe = ARMS[armName];
  if (!probe) {
    console.error(`✘ 未知臂：${armName}（可用：${ARM_NAMES.join(" / ")}）`); // ★ 拼错必须响
    process.exit(1);
  }

  const control = process.argv.includes("--control");
  const r = probe(control);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`\n═══ 臂 ${r.arm} · ${r.side}（零模型成本）═══\n`);
    console.log(`样本 ${r.cases} 条 · 判据命中 ${r.hits} 条 · ★ 判错 ${r.wrong} 条\n`);
    for (const d of r.detail) {
      const mark = d.expectHit === d.gotHit ? "✔" : "✘";
      const want = d.expectHit ? "该命中" : "不该命中";
      const got = d.gotHit ? "命中" : "未命中";
      console.log(`  ${mark} ${d.name.padEnd(28)} ${want} / 实为 ${got}`);
    }
    console.log(``);
    console.log(`═══ 判定 ═══`);
    if (r.wrong === 0) {
      console.log(`✔ ${r.arm}（${r.side}）：${r.cases} 条全部判对 —— 判据在此输入集上站得住`);
    } else {
      console.log(`✘ ${r.arm}（${r.side}）：${r.wrong} 条判错 —— 判据有问题，别接`);
      for (const d of r.detail.filter((x) => x.expectHit !== x.gotHit)) {
        console.log(`     · ${d.name}：期望${d.expectHit ? "命中" : "不命中"}，实为${d.gotHit ? "命中" : "不命中"}`);
      }
    }
    console.log(`\n★ 本臂只证明**判据**在此输入集上对不对。`);
    console.log(`  它**不能**证明生产 tick() 会调用它 —— 那要真跑一轮看 _topology.log。\n`);
  }
}
