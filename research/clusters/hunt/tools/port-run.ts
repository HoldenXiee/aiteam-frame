// port_run —— ★★★★★ 把「可推广」从**说法**变成**可复算的执行证据**
//
// ══════════════════════════════════════════════════════════════════
// ★★★ 为什么要有这个工具（2026-10-25 实测）
//
//   跨载体读数：引外部绝对路径 **2/235（0.9%）** · 其中带命令的 **0（0%）**
//   ⇒ 它读了 `src/index.ts`，但**没在上面跑过任何东西**。
//     「去过」≠「成立」。
//
//   DESIGN §0 要的是「写的东西**可以用作工具**」——
//   一条结论算成立，当且仅当它在 **≥2 个不同载体**上真跑过、且都 exit 0。
//   这个工具就是落这件事的：**命令 + 退出码 + 输出头**，落成账，可被我重跑复核。
//
// ★ 为什么 cwd 只能在自己的空间里：
//   写边界没变（`guard.ts`）。若允许 cwd 在 `src/` 上跑任意命令，
//   等于给了一个绕过写边界的入口（纪律㉑：一件能力多个入口 ⇒ 全堵才有效）。
//   ⇒ 载体 = 它**自己搭的多个 lab/装置**（`面-denom` 就是这么做的：跨载体 4 个）。
//   读外部代码仍然开放（`fsRoot` 只读），引用它 ≠ 在它上面跑。
// ══════════════════════════════════════════════════════════════════

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * ★★★★★ 异步执行（2026-10-25 · 修一个会**冻住整个集群**的坑）
 *
 * ★ 原来的写法是 `execFileSync` —— 它在**集群自己的进程**里同步跑命令。
 *   后果：研究员一跑 3 分钟的实验，**整个事件循环停 3 分钟**：
 *   tick 不再触发、别的 agent 不再推进、日志一片空白。
 *   实测症状：主空间 45 分钟只有 **4 次 tick**，20 分钟只有 1 次。
 * ★★ 判据：凡是"工具里跑命令"，必须异步 —— 否则它同时是**观察者的阻塞源**。
 */
export function runCmd(
  cmd: string,
  cwd: string,
  timeoutMs = 240_000,
): Promise<{ exit: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-lc", cmd],
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number }) | null;
        const exit = e ? (typeof e.code === "number" ? e.code : 1) : 0;
        resolve({ exit, out: `${stdout ?? ""}${stderr ?? ""}${e?.message ?? ""}` });
      },
    );
  });
}


export const PORT_FILE = "port.jsonl";

export interface PortRow {
  at: string;
  by: string;
  /** ★ 这条证据在支持哪一条结论（必须能指回产物）*/
  claim: string;
  /** 载体（相对 lab 的目录，或绝对路径）*/
  carrier: string;
  cmd: string;
  exit: number;
  ms: number;
  /** 输出头（判"真的跑了"的最小证据）*/
  head: string;
}

export function portPath(lab: string): string {
  return join(lab, "work", PORT_FILE);
}

export function appendPort(lab: string, row: PortRow): void {
  mkdirSync(join(lab, "work"), { recursive: true });
  appendFileSync(portPath(lab), JSON.stringify(row) + "\n", "utf8");
}

export function readPort(lab: string): PortRow[] {
  const p = portPath(lab);
  if (!existsSync(p)) return [];
  const out: PortRow[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as PortRow);
    } catch {
      /* 半行 —— 跳过 */
    }
  }
  return out;
}

/**
 * ★★ 并发写会**撕裂行**（2026-10-25 实测：r2 的 `port.jsonl` 12 行里 11 可解析）。
 * ★ 多条研究员并行 `appendFileSync` 同一文件，小写入在 Windows 上**不保证原子**。
 * ★★ 处置：**不静默丢** —— 撕裂行单独计数并报出来（纪律㉜：缺数据 ≠ 0）。
 *   （真正的修法是加锁或每席位一个文件；先让它可见。）
 */
export function readPortTorn(lab: string): number {
  const p = portPath(lab);
  if (!existsSync(p)) return 0;
  let torn = 0;
  for (const line of readFileSync(p, "utf8").split(String.fromCharCode(10))) {
    const t = line.trim();
    if (!t) continue;
    try {
      JSON.parse(t);
    } catch {
      torn++;
    }
  }
  return torn;
}

export interface PortStats {
  runs: number;
  /** 不同的 claim 数 */
  claims: number;
  /** ★★ 在 ≥2 个不同载体上都 exit 0 的 claim 数 —— 这就是「可推广成立」 */
  portable: number;
  /** 跑过但至少一次非 0 的 claim 数 */
  failing: number;
  carriers: string[];
  portableClaims: string[];
  /** ★ 撕裂行数（并发写的代价，要报出来）*/
  torn: number;
}

export function portStats(rows: readonly PortRow[]): PortStats {
  const perClaim = new Map<string, Map<string, number>>(); // claim → carrier → 最后一次 exit
  for (const r of rows) {
    if (!perClaim.has(r.claim)) perClaim.set(r.claim, new Map());
    perClaim.get(r.claim)!.set(r.carrier, r.exit);
  }
  const portableClaims: string[] = [];
  let failing = 0;
  for (const [claim, byCarrier] of perClaim) {
    const carriers = [...byCarrier.keys()];
    const allOk = [...byCarrier.values()].every((e) => e === 0);
    if (carriers.length >= 2 && allOk) portableClaims.push(claim);
    else if ([...byCarrier.values()].some((e) => e !== 0)) failing++;
  }
  return {
    runs: rows.length,
    claims: perClaim.size,
    portable: portableClaims.length,
    failing,
    carriers: [...new Set(rows.map((r) => r.carrier))],
    portableClaims,
    torn: 0,
  };
}

export function renderPort(s: PortStats): string {
  if (s.runs === 0) {
    return (
      "★★ **跨载体成立：未声明**（`work/port.jsonl` 不存在）—— " +
      "★ 一条结论要算可推广，必须在这里留下 **≥2 个载体、都 exit 0** 的证据"
    );
  }
  const list = s.portableClaims.slice(0, 3).map((c) => `「${c.slice(0, 24)}…」`).join(" · ");
  return (
    `★★ **跨载体成立：${s.portable} 条**（≥2 个载体都 exit 0）· 跑过 ${s.runs} 次 / ${s.claims} 条 claim` +
    ` · 载体 ${s.carriers.length} 个 · 有非 0 的 ${s.failing} 条` +
    (s.torn > 0 ? ` · ⚠ 撕裂行 ${s.torn}（并发写，已跳过未静默）` : "") +
    (list ? `　← ${list}` : "")
  );
}

/** ★ cwd 必须在 lab 里面（写边界不变；见文件头的理由）*/
export function insideLab(lab: string, dir: string): boolean {
  const a = resolve(lab).toLowerCase();
  const b = resolve(dir).toLowerCase();
  return b === a || b.startsWith(a + sep);
}

export function makePortRun(deps: { lab: string; selfKey: string }) {
  return defineTool({
    name: "port_run",
    label: "Port Run",
    description:
      "★ **把一条结论真的在另一个载体上跑一遍**，并落成可复算的证据（命令 + 退出码 + 输出头）。\n" +
      "★★ 判据：一条结论算「可推广」，当且仅当它在 **≥2 个不同载体**上都 exit 0。\n" +
      "★ 载体 = 你自己搭的不同 lab / 装置目录（在本 lab 里面）。\n" +
      "★ `claim` 必须写得能指回产物里那条结论 —— 它是账的主键。\n" +
      "★★ 只读外部代码（src/book/forge）**不**算「在它上面跑」；引用 ≠ 成立。",
    parameters: Type.Object({
      claim: Type.String({ description: "★ 你在验证哪一条结论（一句话，要能指回产物）" }),
      carrier: Type.String({ description: "载体目录（相对本 lab，例如 work/lab-A）" }),
      cmd: Type.String({ description: "要跑的命令（例如 `npx tsx probe.ts --n=8`）" }),
    }),
    execute: async (_id, p) => {
      const dir = p.carrier.startsWith("/") || /^[A-Za-z]:/.test(p.carrier)
        ? p.carrier
        : join(deps.lab, p.carrier);
      if (!insideLab(deps.lab, dir)) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `⛔ 载体必须在**本 lab 里面**（写边界不变）：${dir}\n` +
                `★ 你可以在 \`work/\` 下新建任意载体目录。★ 读外部代码是开放的，但「在它上面跑」不允许。`,
            },
          ],
          details: {},
        };
      }
      const t0 = Date.now();
      // ★ 异步执行：同步版会冻住整个事件循环（见 runCmd 的注释）
      const r = await runCmd(p.cmd, dir, 180_000);
      const exit = r.exit;
      const out = r.out;
      const ms = Date.now() - t0;
      const head = out.slice(0, 800);
      try {
        appendPort(deps.lab, {
          at: new Date().toISOString(),
          by: deps.selfKey,
          claim: p.claim,
          carrier: p.carrier,
          cmd: p.cmd,
          exit,
          ms,
          head,
        });
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `⚠ 跑完了但落账失败：${(e as Error).message}` }],
          details: {},
        };
      }
      const st = portStats(readPort(deps.lab));
      return {
        content: [
          {
            type: "text" as const,
            text:
              `exit **${exit}** · ${ms}ms · 载体 \`${p.carrier}\`\n\n` +
              "```\n" +
              head +
              "\n```\n" +
              `\n★ 已落账（\`work/port.jsonl\`）。这条 claim 现在有 ${
                readPort(deps.lab).filter((r) => r.claim === p.claim).length
              } 行证据；**≥2 个不同载体都 exit 0 才算可推广成立**（全账已成立 ${st.portable} 条）。`,
          },
        ],
        details: {},
      };
    },
  });
}
