// G0-2 · 参数扫描器：固定一份系统代码，扫一个参数，跑 N 次，自动收集。
//
// 为什么必须先有它（G0-1 的结论）：
//   跨变体池化挑不出序参量，因为**池化本身就是在比较不同的设计**。
//   要回答"哪个量支配"，只能在**固定设计内扫一个参数**。
//   本文件就是把那件事变成一条命令。
//
// 用法：
//   node demox/bench/scan.ts --system=flat --task=T-A --sweep=corpusPairs=2,4,6,8 --repeat=3
//   node demox/bench/scan.ts --list
//
// 产物：demox/runs/<experiment>.jsonl，一次运行一行（形状见 bench/measure.ts 的 RunRecord）
//
// ★ 三条纪律（都来自 demom 的债务）★
//   ① 任务说明、语料、判据**对所有参数值一字不差** —— 变的只有被测的那个参数。
//   ② 每轮跑之前**清现场**（否则上一轮的产物会让判据误判成通过）。
//   ③ 判据结果由**纯函数**产出并存全文 —— 判据改了能不重跑就重判。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lab, labAt, MODEL } from "../env.ts";
import type { ToolGate } from "../../../src/index.ts";
import { Meter, type RunRecord } from "./measure.ts";import { buildDupTask, getTask, type Task } from "./tasks.ts";
import { buildReviewTask } from "./tasks-review.ts";
import { buildVoucherTask } from "./tasks-voucher.ts";
import { buildIntentTask } from "./tasks-intent.ts";
import { addBait, findContamination, misleadingInstruction, type Injection } from "./inject.ts";
import { redundantSystem } from "./redundant.ts";
import { budgetSystem } from "./budget.ts";
import { carrySystem } from "./carry.ts";
import { overrideSystem } from "./override.ts";
import { ledgerSystem } from "./ledger.ts";
import { commitSystem } from "./commit.ts";
import { wasteSystem } from "./waste.ts";
import { routingSystem } from "./routing.ts";
import { intentSystem } from "./intent.ts";
import { repairSystem } from "./repair.ts";
import { worldshapeSystem } from "./worldshape.ts";
import { wslineSystem } from "./wsline.ts";
import { warnSystem } from "./warn.ts";
import { specSystem } from "./spec.ts";
import { structSystem } from "./struct.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const RUNS_DIR = join(dirname(here), "runs");

// ─────────────────────────────────────────────────────────────
// 1. 现场：把语料铺进 cwd，清掉上一轮产物
// ─────────────────────────────────────────────────────────────

/** 语料 id → 现场文件名（扁平化，避开目录分隔符） */
export function fileOf(id: string): string {
  return id.replace(/[\\/:*?"<>|]/g, "_") + ".md";
}

// ─────────────────────────────────────────────────────────────
// 工具集常量
// ─────────────────────────────────────────────────────────────
//
// ★ 2026-10-15 修：加上了枚举手段（`ls`）★
//
// **为什么要改**（实测，见 `G3-On2-枚举手段假设的验证.md`）：
// 原来所有系统都给 `["read", "write"]` —— **没有列目录的工具**。
// 后果是下游 agent（pipeline 的 S2/S3、review 的 reviewer）不知道目录里有哪些文件，
// 唯一的办法是**猜一个名字去 read**，猜不中就换拼法，一直猜。
//
// 实测读数：
//   · pipeline 那轮 97 次 read、**0 次命中真实文件**（猜 `C1.md`/`材料1.md`/`doc1.md`…）
//   · 全库 39 个 run、8307 次 read，**66.9% 不是语料文件**
//   · 只把工具集换成 `read/write/ls`：90s 卡死 → 36s 完成（再 +find/grep → 16s）
//
// ★ 这是**修 bench，不是加变量**：盲猜是工具集残缺的**非意图副作用**，
//   不是当初想测的东西（当初想测的是“只读扇出”与“自由文本交接”）。
//   把它修掉，后续实验测的才是真正的结构变量。
//
// ⚠️ 与旧数据不再同源（旧数据全部是缺 `ls` 的环境跑的）——
//   见 `已做实验的价值提取.md` 的总口径。
const READ_WRITE = ["read", "write", "ls"];
const READ_ONLY = ["read", "ls"];

export function prepareSite(task: Task, cwd: string, extra?: (cwd: string) => void): void {
  const corpusDir = join(cwd, "corpus");
  // ⚠️ 先清空语料：编号会跨配置复用（旧 M4 与新 M4 是不同材料），不清就会留下陈旧材料
  if (existsSync(corpusDir)) rmSync(corpusDir, { recursive: true, force: true });
  mkdirSync(corpusDir, { recursive: true });
  for (const d of task.corpus) {
    // ★ 文件名必须**扁平化** ★
    // T-A 的 id 是 `M3`（安全），但 T-E 的 id 是 `src/api.js`（带目录），
    // 直接当文件名会去写 `corpus/src/api.js.md` —— 而那个目录不存在，
    // 于是 `prepareSite` 在**铺现场阶段**就崩了（比实验失败更难查）。
    const flat = fileOf(d.id);
    writeFileSync(join(corpusDir, flat), `${d.title}\n\n${d.text}\n`);
  }
  // 清掉上一轮的产物（最容易让实验静默失效的一个点）
  const artifact = join(cwd, task.artifact);
  if (existsSync(artifact)) rmSync(artifact, { force: true });
  // 清掉常见的中间产物目录（r1–r5 是 redundant 系统的每份解答目录）
  for (const d of ["draft", "notes", "work", "r1", "r2", "r3", "r4", "r5"]) {
    const p = join(cwd, d);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  extra?.(cwd);
}

/** 现场自检：语料数对不对、判据的 ground truth 有没有泄露 */
export function checkSite(task: Task, cwd: string): string[] {
  const errs: string[] = [];
  const corpusDir = join(cwd, "corpus");
  const files = existsSync(corpusDir) ? readdirSync(corpusDir) : [];
  if (files.length !== task.corpus.length) errs.push(`语料数不符：现场 ${files.length}，任务 ${task.corpus.length}`);
  // ground truth 绝不能出现在工作目录里
  const hidden = JSON.stringify(task.hidden);
  for (const f of files) {
    const body = readFileSync(join(corpusDir, f), "utf8");
    // 只查最强的那类泄露：groups 的具体配对
    const groups = (task.hidden as { groups?: string[][] }).groups ?? [];
    for (const g of groups) {
      if (body.includes(g.join(" ")) || body.includes(g.join("、"))) {
        errs.push(`ground truth 疑似泄露：${f}`);
      }
    }
    if (body.includes(hidden.slice(0, 40))) errs.push(`ground truth 疑似泄露：${f}`);
  }
  return errs;
}

// ─────────────────────────────────────────────────────────────
// 2. 系统：被测的"那一份系统代码"
//
// flat     = 一个 agent 自己干完（单点，基线）
// star     = 协调者 + N 个只读 scout（判断集中、读分散）
// pipeline = 串行阶段（上游交自由文本给下游）
// 后续 G1/G3/G4/G6 的实验都在这里加新系统。
// ─────────────────────────────────────────────────────────────

export interface SystemSpec {
  id: string;
  /** 一句话：这个系统的结构是什么 */
  what: string;
  /** 跑一次，返回产物（文本 + 结构化）与 meter */
  run: (
    task: Task,
    params: Record<string, number | string>,
    cwd: string,
    progress?: { step: string; meter?: Meter },
    /** 在飞 agent 登记处：超时时扫描器靠它硬中断这一轮 */
    inflight?: { dispose(): void }[],
  ) => Promise<{ meter: Meter; text: string | null; structured: unknown; crashed?: string }>;
  /** 跑完之后把 agent 都收掉（各自实现里调 meter.dispose 也行，这里给个统一出口） */
  cleanup?: () => void;
}

/**
 * 带重试地跑一个系统 —— 并且**记录它卡在哪一步**。
 *
 * 为什么要记进度：实测有多轮超时且 `agents=0 calls=0`，
 * 即“一个 agent 都没起来” —— 但那可能是卡在 `createAgent`、也可能是卡在 `io.prompt`、
 * 也可能是卡在**上层框架的调度**。不记进度就只能靠猜。
 */
async function runWithRetry(
  sys: SystemSpec,
  task: Task,
  params: Record<string, number | string>,
  cwd: string,
  attempts: number,
  progress?: { step: string; meter?: Meter },
  /** 在飞 agent 登记处（用于超时时硬中断） */
  inflight?: { dispose(): void }[],
): Promise<Awaited<ReturnType<SystemSpec["run"]>>> {
  let last: Awaited<ReturnType<SystemSpec["run"]>> | undefined;
  for (let i = 1; i <= attempts; i++) {
    sys.cleanup?.();
    try {
      last = await sys.run(task, params, cwd, progress, inflight);
    } catch (e) {
      // ★ 单轮抛异常绝不能打死整批扫描 ★
      // 实测踩到：一次 agent 已 dispose 的异步 steer 把整个进程干掉了，
      // 于是后面几十轮全部跑不了 —— 一个 bug 吃掉一整批数据。
      last = await crashRecord(sys, e);
    }
    if (!last.crashed || !INFRA_RE.test(last.crashed)) return last;
    if (i < attempts) {
      const wait = Math.min(45, 8 * i);
      console.log(`      ⚡ 基础设施失败（${String(last.crashed).slice(0, 50)}…），${wait}s 后重试（第 ${i + 1}/${attempts} 次）`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  return last!;
}

/** 读语料的工具说明（各系统共用） */
function briefWithCorpus(task: Task): string {
  return task.brief;
}

/** flat：一个 agent 读完所有材料，自己写答案 */
const flat: SystemSpec = {
  id: "flat",
  what: "单 agent：自己读、自己判、自己写（无委派）",
  async run(task, _params, cwd, progress) {
    const meter = new Meter();
    progress && (progress.meter = meter); // 超时时用来分辨两种卡法
    // ⚠ cwd / agentDir **不属 spec** —— 它们是实验室级的（src/agent/lab.ts 的 LabOptions）。
    // ⚠ 工具白名单叫 `permissions.only`（精确就是这些）；自定义工具在 `tools.custom` 里。
    const agent = await lab.createAgent({
      id: `flat-${Date.now()}`,
      model: MODEL,
      role: "你独自完成整个任务。用 read 看材料，用 write 写产物。",
      permissions: { only: READ_WRITE },
    });
    meter.watch(agent, { role: "solo", depth: 1 });
    let crashed: string | undefined;
    try {
      const res = await agent.io.prompt(briefWithCorpus(task));
      if (res.error) crashed = `轮失败：${res.error}`;
    } catch (e) {
      crashed = (e as Error).message;
    }
    meter.settle();
    const text = readArtifact(cwd, task.artifact);
    meter.dispose();
    return { meter, text, structured: parseArtifact(text), crashed };
  },
};

/** star：协调者可以自己读，也可以派只读 scout；只有它能写 */
const star: SystemSpec = {
  id: "star",
  what: "星形：协调者 + N 个只读 scout（协调者保留写权与最终判断）",
  async run(task, params, cwd, progress) {
    const meter = new Meter();
    progress && (progress.meter = meter); // 超时时用来分辨两种卡法
    progress && (progress.step = "开始（star：建 root）");
    const maxScouts = Number(params.maxScouts ?? 3);
    let spawned = 0;

    // spawn 工具：起一个只读 scout，把它的**文本**回给协调者
    const { defineTool } = await import("@earendil-works/pi-coding-agent");
    const { Type } = await import("typebox");
    // ⚠ `details` 的形状必须是**一个**类型：不同分支返回不同 details，
    // 不标注的话 tsc 会拿第一个分支的字面量当契约（demo/lab.ts 里也踩过同一个坑）。
    type SpawnDetails = { spawned: number; note?: string };
    const spawn = defineTool({
      name: "spawn_scout",
      label: "派一个只读助手",
      description: `派一个只读助手去读一部分材料，把它的发现带回来。最多派 ${maxScouts} 个，已经派了 ${spawned} 个。`,
      parameters: Type.Object({ task: Type.String({ description: "让助手做什么（说清读哪些编号）" }) }),
      execute: async (_id: string, p: { task: string }): Promise<{ content: { type: "text"; text: string }[]; details: SpawnDetails }> => {
        if (spawned >= maxScouts) {
          return {
            content: [{ type: "text" as const, text: `派不出去了（已达上限 ${maxScouts}）` }],
            details: { spawned, note: "超限" },
          };
        }
        spawned += 1;
        const parentId = root.id;
        const scout = await lab.createAgent({
          id: `scout-${spawned}-${Date.now()}`,
          model: MODEL,
          role: "只读助手：读指定的材料，报告你发现的「哪些在讲同一件事 / 哪些无关」。不要写文件。",
          permissions: { only: READ_ONLY },
        });
        meter.watch(scout, { role: "scout", parent: parentId, depth: 2 });
        let out = "";
        try {
          const r = await scout.io.prompt(p.task);
          out = r.text ?? "";
        } catch (e) {
          out = `助手出错：${(e as Error).message}`;
        }
        meter.settle();
        return { content: [{ type: "text" as const, text: out || "(助手没有回话)" }], details: { spawned } };
      },
    });

    const root = await lab.createAgent({
      id: `root-${Date.now()}`,
      model: MODEL,
      role:
        "你是协调者。你可以自己 read 材料，也可以派只读助手帮你读。**最终判断与写文件都由你自己做。**" +
        "材料不多时自己读可能更省事。",
      permissions: { only: READ_WRITE },
      tools: { custom: [spawn] },
    });
    meter.watch(root, { role: "root", depth: 1 });

    let crashed: string | undefined;
    try {
      const res = await root.io.prompt(briefWithCorpus(task));
      if (res.error) crashed = `轮失败：${res.error}`;
    } catch (e) {
      crashed = (e as Error).message;
    }
    meter.settle();
    const text = readArtifact(cwd, task.artifact);
    meter.dispose();
    return { meter, text, structured: parseArtifact(text), crashed };
  },
};

function readArtifact(cwd: string, name: string): string | null {
  const p = join(cwd, name);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function parseArtifact(text: string | null): unknown {
  if (!text) return null;
  try {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s < 0 || e <= s) return null;
    return JSON.parse(text.slice(s, e + 1));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// G1 · 控制论：带反馈护栏的 flat
//
// 动机（G0-3 实测）：**代价失控在单 agent 单轮就能发生**。
//   pairs=16 那轮：72 次 read、1 次 write、269 万 token、43 分钟——**而产物是对的**。
// ⇒ 护栏不能以「做没做对」为触发条件，必须独立于正确性，只看**结构性**指标。
//
// 这就是一个**负反馈控制器**，它只有两个参数：
//   · `pollEvery` —— 采样率（每 k 次工具调用检查一次）
//   · `grace`     —— 死区 / 允许超调（越限之后还给多少次调用收尾）
//   · `action`    —— 控制方式：steer（比例控制）或 abort（开关控制）
//
// ⚠ 为什么不能用 agent.usage 当读数（demom §4.2 的库层缺口）：
//   `agent.usage` 是在 **prompt 结算之后**才累加的，跑的过程中是陈的。
//   拿它做实时闸会**静默不生效**——一个 agent 在单轮内失控对它完全不可见。
//   所以本题的反馈信号来自 `tool_call` 事件计数（实时、可靠）。
// ─────────────────────────────────────────────────────────────

interface GuardCfg {
  pollEvery: number;
  cap: number;
  grace: number;
  action: "steer" | "abort" | "none";
}

function guardedFlat(): SystemSpec {
  return {
    id: "flat-guarded",
    what: "单 agent + 实时护栏（tool_call 计数 → steer/abort）",
    async run(task, params, cwd, progress) {
      const meter = new Meter();
      progress && (progress.meter = meter); // 超时时用来分辨两种卡法
      progress && (progress.step = "开始（flat-guarded）");
      const cfg: GuardCfg = {
        pollEvery: Number(params.pollEvery ?? 1),
        cap: Number(params.callCap ?? 30),
        grace: Number(params.grace ?? 0),
        action: (params.action as GuardCfg["action"]) ?? "steer",
      };

      const agent = await lab.createAgent({
        id: `gflat-${Date.now()}`,
        model: MODEL,
        role: "你独自完成整个任务。用 read 看材料，用 write 写产物。",
        permissions: { only: READ_WRITE },
      });
      meter.watch(agent, { role: "solo", depth: 1 });

      // ── 控制器状态 ──
      let calls = 0;
      let lastChecked = 0;
      let vacated = false; // 已经拉回来过一次（滞回：只在第一次越限时 steer）
      let aborted = false;
      // ★ 收尾旗：prompt 结算之后禁止再向 agent 发 steer/interrupt ★
      // 实测踩到：`void agent.io.steer(...)` 是异步的，若它在 agent 已 dispose 之后才执行，
      // 库会抛 `agent ... 已 dispose，不能再操作` —— 这个异常会**打死整个扫描**，
      // 让后面所有轮次都跑不了。所以这两类“发后不管”的调用必须自己护住。
      let finished = false;
      const cap = cfg.cap;
      const hardCap = cfg.cap + cfg.grace;

      /** 安全地发一句 steer（不抛、不阻塞、结算后不发） */
      const safeSteer = (t: string) => {
        if (finished) return;
        try {
          void Promise.resolve(agent.io.steer(t)).catch(() => {});
        } catch {
          /* agent 已经没了 —— 忽略 */
        }
      };
      const safeInterrupt = (t: string) => {
        if (finished) return;
        try {
          void Promise.resolve(agent.io.interrupt(t)).catch(() => {});
        } catch {
          /* 同上 */
        }
      };

      const off = agent.on("tool_call", () => {
        calls += 1;
        if (finished) return;
        // ★ 采样率：每 pollEvery 次才检查一次 ★
        if (cfg.pollEvery > 1 && calls - lastChecked < cfg.pollEvery) return;
        lastChecked = calls;
        if (calls < cap) return;

        if (cfg.action === "abort") {
          // 开关控制：到限就打死
          if (calls >= hardCap && !aborted) {
            aborted = true;
            meter.noteGuard("solo", calls, cap, "abort");
            safeInterrupt("已超出预算上限，停止工具调用，把当前已掌握的结果直接写成产物。");
          }
          return;
        }

        if (cfg.action === "steer") {
          // 比例控制：拉回来，给一个收尾余地（不打断在飞那轮）
          if (!vacated) {
            vacated = true;
            meter.noteSteer("solo", calls, `超过上限 ${cap}`, cfg.grace);
            safeSteer(
              `你已经做了 ${calls} 次工具调用，超过本轮上限（${cap}）。` +
                `请**立刻停止继续读材料**，直接用你已经看到的内容写出产物文件，不要再调用 read。`,
            );
          } else if (calls >= hardCap && !aborted) {
            // 拉了没用 → 才昇级到 abort（最后手段）
            aborted = true;
            meter.noteGuard("solo", calls, hardCap, "拉过没用，abort");
            safeInterrupt("必须停了：立刻把已知结果写成产物，不要再读任何文件。");
          }
        }
      });

      let crashed: string | undefined;
      try {
        const res = await agent.io.prompt(briefWithCorpus(task));
        if (res.error) crashed = `轮失败：${res.error}`;
      } catch (e) {
        crashed = (e as Error).message;
      }
      // ★ 先落旗（后续回调不再发 steer），再退订，再结算 ★
      finished = true;
      off();
      // steer 是排在下一次 LLM 调用之前的，prompt 结算后可能还有一句在飞 —— 等一下再收
      await new Promise((r) => setTimeout(r, 50));
      meter.settle();
      const text = readArtifact(cwd, task.artifact);
      meter.dispose();
      return { meter, text, structured: parseArtifact(text), crashed };
    },
  };
}

export const SYSTEMS: Record<string, SystemSpec> = {
  flat,
  star,
  "flat-guarded": guardedFlat(),
  pipeline: pipelineSystem(),
  review: reviewSystem(),
  protocol: protocolSystem(),
  redundant: redundantSystem({ lab, MODEL, READ_WRITE }),
  budget: budgetSystem({ lab, MODEL, READ_WRITE }),
  carry: carrySystem({ lab, MODEL, READ_WRITE }),
  override: overrideSystem({ lab, MODEL, READ_WRITE }),
  ledger: ledgerSystem({ lab, MODEL, READ_WRITE }),
  commit: commitSystem({ lab, MODEL, READ_WRITE }),
  waste: wasteSystem({ lab, MODEL, READ_WRITE }),
  routing: routingSystem({ lab, MODEL }),
  intent: intentSystem({ lab, MODEL }),
  repair: repairSystem({ lab, MODEL }),
  worldshape: worldshapeSystem({ lab, MODEL }),
  wsline: wslineSystem({ lab, MODEL }),
  warn: warnSystem({ lab, MODEL }),
  spec: specSystem({ lab, MODEL }),
  struct: structSystem({ lab, MODEL }),
};

// ─────────────────────────────────────────────────────────────
// T-E 的两个系统：真实形状（Cloudflare）vs 它的单点仲裁版
//
// 对应 `真实工作形态调研.md` 里的关键结构：
//   · Cloudflare 的子 reviewer **只读、且只读自己的分片**（不是把上下文复制七份）
//   · 一个**协调者**做去重与仲裁 —— 调研 Q2 说这就是把 **O(n²) 降回 O(n)** 的办法
//
// 所以这里把“有/无协调者”做成一个系统参数 `coordinator`：
//   coordinator=0  → 每个 reviewer 各自写产物（写共享）→ 会互相覆盖
//   coordinator=1  → reviewer 只回报告，由协调者**单点**汇总成产物（只读）
// ─────────────────────────────────────────────────────────────
function reviewSystem(): SystemSpec {
  return {
    id: "review",
    what: "只读扇出 + 可选协调者（真实活：代码审查）",
    async run(task, params, cwd, progress, inflight) {
      const meter = new Meter();
      progress && (progress.meter = meter); // 超时时用来分辨两种卡法
      progress && (progress.step = "开始（review：建 root）");
      const shards = Number(params.shards ?? 2);
      const coordinator = params.coordinator !== 0;
      const { defineTool } = await import("@earendil-works/pi-coding-agent");
      const { Type } = await import("typebox");
      const readdirSync = (await import("node:fs")).readdirSync;

      const files = readdirSync(join(cwd, "corpus"));
      // 现场文件名是扁平化的，但任务里看到的 id 是原路径（如 src/api.js）——
      // 两边的映射要一致，否则 reviewer 读不到文件。
      const idOf = (f: string) => f.replace(/\.md$/, "").replace(/_/g, "/");
      const per = Math.ceil(files.length / shards);
      const groups = Array.from({ length: shards }, (_, i) => files.slice(i * per, (i + 1) * per)).filter((g) => g.length);

      let rootId = "";

      type SpawnDetails = { spawned: number; files: string[]; note?: string };
      const spawn = defineTool({
        name: "spawn_reviewer",
        label: "派一个只读审查员",
        description:
          `派一个只读审查员去看一部分文件，把它的发现带回来。它**只能看**、不能写产物。` +
          `当前可用分片：${groups.map((g, i) => `#${i + 1}(${g.join(",")})`).join(" ")}`,
        parameters: Type.Object({ shard: Type.Number({ description: "要派第几个分片（从 1 开始）" }) }),
        execute: async (_id: string, p: { shard: number }): Promise<{ content: { type: "text"; text: string }[]; details: SpawnDetails }> => {
          const g = groups[p.shard - 1];
          if (!g) {
            return { content: [{ type: "text" as const, text: `没有第 ${p.shard} 个分片（共 ${groups.length} 个）` }], details: { spawned: 0, files: [], note: "越界" } };
          }
          const rev = await lab.createAgent({
            id: `rev-${p.shard}-${Date.now()}`,
            model: MODEL,
            role:
              "你是只读代码审查员。只看指定的那几个文件，找出**真实缺陷**。" +
              "报错（文件里其实没问题）会扣分，所以不确定的不要报。不要写任何文件。",
            permissions: { only: READ_ONLY },
          });
          meter.watch(rev, { role: `reviewer-${p.shard}`, parent: rootId, depth: 2 });
          inflight?.push(rev); // 超时时扫描器靠它硬中断这一轮
          let out = "";
          progress && (progress.step = `reviewer-${p.shard} prompt 中`);
          try {
            const r = await rev.io.prompt(
              `用 read 看这些文件：${g.map((f) => `corpus/${f}`).join("、")}\n\n` +
                `（它们的路径分别是：${g.map(idOf).join("、")}）\n\n` +
                `找出其中的真实缺陷，直接回答（不要写文件）：哪些文件有缺陷、缺陷是什么。`,
            );
            out = r.text ?? "";
          } catch (e) {
            out = `审查员出错：${(e as Error).message}`;
          }
          return { content: [{ type: "text" as const, text: out || "(审查员没有回话)" }], details: { spawned: 1, files: g } };
        },
      });

      const root = await lab.createAgent({
        id: `revroot-${Date.now()}`,
        model: MODEL,
        role: coordinator
          ? "你是协调者。你可以自己 read，也可以派只读审查员分片去看。**最终由你汇总成产物。**"
          : "你是审查员。自己 read 所有文件，把结果写成产物。",
        permissions: { only: READ_WRITE },
        tools: { custom: [spawn] },
      });
      rootId = root.id;
      meter.watch(root, { role: coordinator ? "coordinator" : "solo", depth: 1 });
      inflight?.push(root); // 超时时扫描器靠它硬中断这一轮
      // 让协调者在提示里拿到文件清单（相当于 Cloudflare 的共享上下文）
      let crashed: string | undefined;
      progress && (progress.step = `root 已建，正在 prompt（${files.length} 个文件）`);
      try {
        const res = await root.io.prompt(`${task.brief}\n\ncorpus/ 里的文件：${files.join("、")}`);
        progress && (progress.step = `root prompt 已返回（${res.text?.length ?? 0} 字符）`);
        if (res.error) crashed = `轮失败：${res.error}`;
      } catch (e) {
        crashed = (e as Error).message;
      }
      meter.settle();
      const text = readArtifact(cwd, task.artifact);
      meter.dispose();
      return { meter, text, structured: parseArtifact(text), crashed };
    },
  };
}

// ─────────────────────────────────────────────────────────────
// G2/G3 · pipeline：多跳链，用来测「错误传下去会怎样」
//
// 形状：S1-摸底 → S2-去重 → S3-成文（每一跳一个 agent，串行交接）
//   · 跳与跳之间**只能交接自由文本**（写进 draft/ 文件）—— 这是 demom 里的“断流”
//   · 与 demom 的 B 实验室不同之处：这里跳数可扫（跳数 = 衰减距离）
//
// 注入点：`injectAt` 指定在哪一跳的输入里加上“误导指令”
//   · injectAt=1 → 错误从最开始就进来（应容易被发现）
//   · injectAt=2 → 错误在中游进来（上游是干净的）
//   · injectAt=0 → 不注入（对照组）
//   · injectAt=-1 → 每一跳都告诉它“独立核对原文”（= 有中心校验的对照）
// ─────────────────────────────────────────────────────────────
function pipelineSystem(): SystemSpec {
  return {
    id: "pipeline",
    what: "串行流水线：S1-摸底 → S2-去重 → S3-成文（自由文本交接，可定点注入）",
    async run(task, params, cwd, progress) {
      const meter = new Meter();
      progress && (progress.meter = meter);
      progress && (progress.step = "开始（pipeline：建 S1）");
      const stages = Number(params.stages ?? 3);
      const injectAt = Number(params.injectAt ?? 0);
      const baitCount = Number(params.baitCount ?? 1);
      const handoff = String(params.handoff ?? "narrow");

      // verify 的措辞强度（G3-3 的延伸；F′ 要重新审视的正是这条线）
      const verifyLevel = Number(params.verify ?? 0);
      const verifyText =
        verifyLevel === 1
          ? "\n\n⚠ 不要相信上游的结论：请自己 read corpus/ 逐组核对，发现不对就改。"
          : verifyLevel === 2
            ? "\n\n⚠ 上游的判断**可能有错**，而且最常见的错法是：**把两份实际在讲不同事情的材料说成是同一件事**。" +
              "请对每一组都自己 read 那两份材料的原文，问自己一句：**它们真的是同一件事吗？**"
            : "";

      // 注入：先加诱饵材料（**必顶在 prepareSite 之后**，否则会被清掉）
      let baitPairs: string[][] = [];
      if (injectAt !== 0) {
        const bait = addBait(task, cwd, baitCount);
        baitPairs = bait.texts;
        meter.noteInjection(String(injectAt), `在它们之间加了 ${baitCount} 对诱饵材料（B 前缀）`, bait.markers.join(","));
      }

      const handoffTags: Record<string, string> = {
        narrow: "下游只拿结论（无原文、无查证手段）",
        attenuate: "上游先做结构化摘要，下游只看摘要",
        amplify: "下游拿到完整原文，且被要求自己抽查",
      };
      meter.noteInjection("handoff", handoffTags[handoff] ?? handoff, handoff);

      const corpusListNote =
        handoff === "amplify"
          ? `\n\n📋 corpus/ 的完整清单（${task.corpus.length} 份）：` +
            task.corpus.map((d) => fileOf(d.id)).join("、") +
            "\n⚠ 你必须自己 read 至少其中若干份原文来核实上游的结论，**不要把上游的结论直接当成事实**。"
          : "";
      const attenuateNote =
        handoff === "attenuate"
          ? "\n\n⚠ 交接方式：你**只应该依据上游给出的结构化摘要**做判断。" +
            "**不要**再去读 corpus/ 原文 —— 那是上一环节已经完成的活。" +
            "摘要里没写的，就当作不知道。"
          : "";

      const stagesDef = [
        {
          id: "S1-摸底",
          role: "你负责摸底：看清 corpus/ 里有哪些材料、它们大致在说什么。不要下结论，只写你看到的。",
          task: "列出 corpus/ 里每份材料的编号与它讲的一句话大意，写进 draft/survey.md。",
        },
        {
          id: "S2-去重",
          role: "你负责去重：找出哪些材料在讲同一件事。你可以自己 read corpus/ 逐组核对。",
          task: '读 draft/survey.md，给出重复组列表，写进 draft/groups.json（形如 {"duplicates":[["M1","M2"]]}）。',
        },
        {
          id: "S3-成文",
          role: `你负责落盘：把分组结论写成 ${task.artifact}。**只有你能写产物。**`,
          task: `读 draft/groups.json，把结果写成 ${task.artifact}（形如 {"duplicates":[["M1","M2"]],"irrelevant":[]}）。`,
        },
        {
          id: "S4-复核",
          role: "你负责复核：对已经写好的分组逐个核对，发现不对就改。",
          task: `读 ${task.artifact}，对每一组问「这两份真的是同一件事吗」，把修正后的结果写回去。`,
        },
        {
          id: "S5-终审",
          role: "你负责终审：最后过一遍产物，确保结论站得住。",
          task: `读 ${task.artifact}，做最后一次修正并写回去。`,
        },
      ].slice(0, stages);

      let crashed: string | undefined;
      for (const st of stagesDef) {
        const n = Number(st.id.slice(1, 2));
        const agent = await lab.createAgent({
          id: `${st.id}-${Date.now()}`,
          model: MODEL,
          role: st.role,
          permissions: { only: READ_WRITE },
        });
        progress && (progress.step = `prompt 中（${st.id}）`);
        meter.watch(agent, { role: st.id, depth: n });

        let extra = verifyText;
        if (n > 1) extra += handoff === "amplify" ? corpusListNote : handoff === "attenuate" ? attenuateNote : "";
        if (injectAt > 0 && n === injectAt && baitPairs.length) {
          extra += misleadingInstruction(baitPairs);
        }
        try {
          const res = await agent.io.prompt(st.task + extra);
          if (res.error) crashed = `${st.id} 轮失败：${res.error}`;
        } catch (e) {
          crashed = `${st.id} 崩了：${(e as Error).message}`;
        }
        if (crashed) break;
      }

      meter.settle();
      const text = readArtifact(cwd, task.artifact);
      meter.dispose();
      return { meter, text, structured: parseArtifact(text), crashed };
    },
  };
}

/** 在飞的量具 → 总工具调用数。超时时用它分辨「端点挂死」与「卡在里面」 */
function sumCalls(meter: Meter): number {
  return meter.records.reduce((s, r) => s + r.toolCalls, 0);
}

function protocolSystem(): SystemSpec {
  return {
    id: "protocol",
    what: "F′ · 三种消息内容（只给结论 / 给清单 / 要求核实）—— 测「给下游多少信息」",
    async run(task, params, cwd, progress) {
      const meter = new Meter();
      progress && (progress.meter = meter);
      progress && (progress.step = "开始（protocol）");
      const stages = Number(params.stages ?? 3);
      const infoLevel = String(params.protocol ?? "conclusion");

      // ─────────────────────────────────────────────────────────
      // ★ 这个系统改过两次设计，两次都是被实测逼出来的 ★
      // （全过程见 `过程笔记-F′隔离的失败.md`）
      //
      // **第一版**：想测「结构级隔离」——给下游一个看不到 corpus 的工作区。
      //   试了四种做法：同树 .stage/ · 同树 stash · 父目录 stash · 仓库外工作区。
      //   前三种被 agent **自己翻出来**；第四种（permissions.gate）**一次都没拦上**。
      //
      // ★ 反转：拦住它的从来不是文件系统，是**那句话**。
      //   告诉它「你只有这些」→ 它就真的不去找了（gate 零触发，找出 0/8 组）。
      //   ⇒ 与文件系统布局无关；agent 去不去找，取决于它认为任务要求什么。
      //
      // **第二版（本版）**：既然结构隔离测不了，就测**真正可操纵的东西**：
      //   消息里装多少信息。共享 cwd，只改给下游的信息量：
      //
      //   conclusion  只给上游结论     「你只拿到结论，没有别的渠道」
      //   summary     结论 + **文件清单**  ★ 这正是 **P5 的做法**（给枚举手段）
      //   verify      清单 + 要求自己核实原文  = F 的 amplify 档
      //
      // ★ 操纵检验：三档的「下游实际读了多少」可直接比。
      const corpusList = task.corpus.map((d) => fileOf(d.id)).join("、");

      const noteOf = (n: number): string => {
        if (n <= 1) return ""; // 源头没有“上游”
        if (infoLevel === "conclusion") {
          return (
            "\n\n📨 你只拿到上游产出的结论（draft/ 里那些）。" +
            "**没有其他渠道**——不要再去找别的东西，直接基于这份结论做你这一步。"
          );
        }
        if (infoLevel === "summary") {
          return (
            `\n\n📋 上游产出的结论在 draft/ 里；另外，材料目录 corpus/ 的完整清单是（${task.corpus.length} 份）：` +
            corpusList +
            "\n需要时你可以直接 read 其中任意几份来核对上游的结论。"
          );
        }
        if (infoLevel === "verify") {
          return (
            `\n\n📋 材料目录 corpus/ 的完整清单是（${task.corpus.length} 份）：` +
            corpusList +
            "\n⚠ 你必须自己 read 至少若干份原文来核实上游的结论，**不要把上游的结论直接当成事实**。"
          );
        }
        return "";
      };

      const stagesDef = [
        {
          id: "S1-摸底",
          role: "你负责摸底：看清 corpus/ 里有哪些材料、它们大致在说什么。不要下结论，只写你看到的。",
          task: "列出 corpus/ 里每份材料的编号与它讲的一句话大意，写进 draft/survey.md。",
        },
        {
          id: "S2-去重",
          role: "你负责去重：找出哪些材料在讲同一件事。",
          task: '给出重复组列表，写进 draft/groups.json（形如 {"duplicates":[["M1","M2"]]}）。',
        },
        {
          id: "S3-成文",
          role: `你负责落盘：把分组结论写成 ${task.artifact}。**只有你能写产物。**`,
          task: `把结果写成 ${task.artifact}（形如 {"duplicates":[["M1","M2"]],"irrelevant":[]}）。`,
        },
      ].slice(0, stages);

      let crashed: string | undefined;
      for (let i = 0; i < stagesDef.length; i++) {
        const st = stagesDef[i];
        const n = i + 1;
        const agent = await lab.createAgent({
          id: `${st.id}-${Date.now()}`,
          model: MODEL,
          role: st.role,
          permissions: { only: READ_WRITE },
        });
        progress && (progress.step = `prompt 中（${st.id}）`);
        meter.watch(agent, { role: st.id, depth: n });

        try {
          const res = await agent.io.prompt(st.task + noteOf(n));
          if (res.error) crashed = `${st.id} 轮失败：${res.error}`;
        } catch (e) {
          crashed = `${st.id} 崩了：${(e as Error).message}`;
        }
        if (crashed) break;
      }

      meter.settle();
      const text = readArtifact(cwd, task.artifact);
      meter.dispose();
      return { meter, text, structured: parseArtifact(text), crashed };
    },
  };
}

function findFile(root: string, name: string): string | null {
  if (!existsSync(root)) return null;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (e.name === name) {
      return p;
    }
  }
  return null;
}

/**
 * 基础设施失败的识别串（免费档限流、连接错误、端点挂死…）。判断在 scan.ts 里做，见那段注释。
 *
 * ★ 2026-10-15 改：只把**端点挂死**（零工具调用）算基础设施失败。★
 * 「运行中卡住」（已有工具调用）**故意不匹配** —— 那可能是研究对象本身
 * （G3-3b 要测的“O(n²) 校验失控”就该长那样），当基础设施丢掉会把现象洗掉。
 */
export const INFRA_RE = /429|Connection error|Endpoint is unavailable|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|端点挂死/i;

/**
 * 给一个 promise 加墙钟上限。
 *
 * ★ 重要：“超时”只是停止了**等待**，它不会停止**底下那件事** ★
 * 实测踩到：`Promise.race` 返回后，`finally` 把计时器清了，而底层那个卡住的 reviewer
 * 还在跑 —— 于是进程被它吊着，直到它自己超时（实测 2682 秒，而我设的上限是 420）。
 * 所以调用方必须在超时后**主动把这一轮的 agent 收掉**（见 onTimeout 回调）。
 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  onTimeout?: () => void,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => {
          // 先断开底层，再解决这个 race —— 否则进程会被吊住
          try {
            onTimeout?.();
          } catch {
            /* 断开失败也不能影响主流程 */
          }
          resolve({ timedOut: true });
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────
// 3. 扫描：笛卡尔积 × repeat
// ─────────────────────────────────────────────────────────────

export interface ScanOpts {
  system: string;
  task: string;
  /** 扫描轴：`名=值1,值2,...`；可以给多条（笛卡尔积） */
  axes: { name: string; values: (number | string)[] }[];
  repeat: number;
  experiment: string;
  /** 每轮的最大墙钟秒数（防跑飞） */
  timeoutSec: number;
}

export function parseAxes(specs: string[]): { name: string; values: (number | string)[] }[] {
  return specs.map((s) => {
    const [name, rest] = s.split("=");
    if (!name || !rest) throw new Error(`扫描轴格式错：${s}（应为 名=值1,值2）`);
    return { name, values: rest.split(",").map((v) => (v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v.trim())) };
  });
}

/**
 * 参数静默失效自检：任务层可观测的旋钮，必须真的随参数变化。
 *
 * 目前只查两个最容易被忘的：
 *   `corpusPairs` → 语料份数应该 = pairs*2 + distractors
 *   `fillerCount` → 语料份数应该至少包含填充文件
 * 其它参数（系统级的，如 shards/coordinator）不在此列 —— 它们不影响语料。
 */
function assertParamsTookEffect(task: Task, params: Record<string, number | string>): void {
  if (params.fillerCount !== undefined && Number(params.fillerCount) > 0) {
    const want = Number(params.fillerCount);
    if (task.corpus.length < want) {
      throw new Error(
        `参数静默失效：fillerCount=${want}，但任务只造出 ${task.corpus.length} 份语料 —— ` +
          `多半是 buildTaskFor 忘了把这个参数传给任务构造函数`,
      );
    }
  }
}

function combos(axes: { name: string; values: (number | string)[] }[]): Record<string, number | string>[] {
  let out: Record<string, number | string>[] = [{}];
  for (const a of axes) {
    const next: Record<string, number | string>[] = [];
    for (const c of out) for (const v of a.values) next.push({ ...c, [a.name]: v });
    out = next;
  }
  return out;
}

export async function runScan(opts: ScanOpts): Promise<string> {
  const sys = SYSTEMS[opts.system];
  if (!sys) throw new Error(`未知系统：${opts.system}（有：${Object.keys(SYSTEMS).join(", ")}）`);
  const taskId = opts.task;
  const combosList = combos(opts.axes);
  mkdirSync(RUNS_DIR, { recursive: true });
  const outFile = `${opts.experiment}.jsonl`;
  // ⚠️ 同名实验重跑：先备份，不静默覆盖（数据丢了没法重判）
  const outPath = join(RUNS_DIR, outFile);
  if (existsSync(outPath)) {
    const bak = join(RUNS_DIR, `${opts.experiment}-bak-${Date.now()}.jsonl`);
    writeFileSync(bak, readFileSync(outPath));
    console.log(`  （同名实验已存在，旧文件备份到 ${bak.split(/[\\/]/).pop()}）`);
    rmSync(outPath, { force: true });
  }

  console.log(`\n扫描 ${opts.experiment}`);
  console.log(`  系统 ${sys.id} —— ${sys.what}`);
  console.log(`  任务 ${taskId} · 组合 ${combosList.length} × 重复 ${opts.repeat} = ${combosList.length * opts.repeat} 轮`);
  console.log(`  模型 ${MODEL}`);
  console.log(`  记录 → demox/runs/${outFile}\n`);

  const cwd = lab.cwd;
  let done = 0;
  /** 本次扫描的全部记录（用于最后的规模自检） */
  const allRecords: RunRecord[] = [];
  for (const params of combosList) {
    for (let rep = 1; rep <= opts.repeat; rep++) {
      // ★ 每个参数值用**它自己的语料** ★ —— 任务按 params 重建（G0-2 的意义就在这）
      const task = buildTaskFor(taskId, params);
      prepareSite(task, cwd);
      const errs = checkSite(task, cwd);
      if (errs.length) {
        console.log(`  ✗ 现场自检不过：${errs.join("; ")}`);
        continue;
      }

      const t0 = Date.now();
      // ★ 自检：参数有没有真的传到任务层 ★
      // 实测踩到：`fillerCount` 加在 params 里但 `buildTaskFor` 忘了读它，
      // 于是“规模扫描”扫了个寂寞 —— 语料数一直没变，而**数据里看不出来**。
      // 这类“参数静默失效”与 demom 的配置层静默失败是同一族，必须在跑之前报。
      assertParamsTookEffect(task, params);
      // ★ 单轮墙钟上限 ★
      // 实测踩到：一轮跑了 32 分钟而只烧了 4k token（**卡住**，不是贵）。
      // 不封顶的话，一批扫几十轮会直接被拖死（前面已经超时一次）。
      // 超时就判这一轮作废并标记，**不算能力失败**。
      // `progress` 由系统在关键节点自己更新 —— 超时时能把“卡在哪一步”写进记录。
      const progress = { step: "未开始" } as { step: string; meter?: Meter };
      // ★ 超时必须真的把这一轮掐断 ★
      // `withTimeout` 只停止“等待”，不会停止底下正在跑的 agent。
      // 这里让 lab 级别的所有在飞 agent 被 dispose —— 这是库提供的唯一硬中断手段。
      const inflight: { dispose(): void }[] = [];
      const runOne = runWithRetry(sys, task, params, cwd, 3, progress, inflight);
      // ★ 超时时把「在飞的量具」抢下来 ★ —— 否则只能记一条“超时”，分不清两种情形（见下）
      let inflightMeter: Meter | undefined;
      const timed = await withTimeout(runOne, opts.timeoutSec * 1000, () => {
        inflightMeter = progress.meter;
        for (const a of inflight) {
          try {
            a.dispose();
          } catch {
            /* 已 dispose 就算了 */
          }
        }
      });
      // ★ 超时分两种，处置完全不同（2026-10-15 研究员定）★
      //
      //   · **端点挂死**（toolCalls === 0）：prompt 发出去就没响动了 —— 这是基础设施，不是能力。
      //     实测：longcat 档稳定 1/3 成功，挂死时 75s+ 无任何工具调用。
      //   · **卡在里面**（toolCalls > 0）：真的在干活但收不了尾 —— **这可能是研究对象本身**
      //     （G3-3b 的“O(n²) 校验失控”就该长这样）。
      //
      // 两者旧版被合成一个「单轮超时」，于是一个端点问题看起来像研究现象。
      const timedOutCalls = inflightMeter ? sumCalls(inflightMeter) : 0;
      if (timed.timedOut) {
        const kind = timedOutCalls === 0 ? "端点挂死（零工具调用）" : `卡在运行中（已有 ${timedOutCalls} 次工具调用）`;
        console.log(`      ⏱ 超时（>${opts.timeoutSec}s）：${kind}，卡在：${progress.step}`);
      }
      type JudgeOverride = { ok: boolean; failed: string[]; detail: string };
      const { meter, text, structured, crashed } = (timed.timedOut
        ? {
            meter: inflightMeter ?? new Meter(),
            text: null,
            structured: null,
            crashed:
              timedOutCalls === 0
                ? `单轮超时（端点挂死，零工具调用）>${opts.timeoutSec}s（卡在：${progress.step}）`
                : `单轮超时（运行中卡住，${timedOutCalls} 次工具调用）>${opts.timeoutSec}s（卡在：${progress.step}）`,
            judgeOverride: undefined as JudgeOverride | undefined,
          }
        : timed.value) as {
        meter: Meter;
        text: string | null;
        structured: unknown;
        crashed: string | undefined;
        judgeOverride?: JudgeOverride;
      };
      // ★ 系统可以自带判据（T-F 的「真跑 npm test」办不到由 task.judge 表达 ——
      //   它需要**在沙箱里执行命令**，不是纯函数）。
      //   这是唯一允许的例外，而且它比纯函数更硬：退出码不可伪造。
      const override = typeof crashed === "string" && /超时/.test(crashed) ? undefined : (timed.timedOut ? undefined : (timed.value as { judgeOverride?: JudgeOverride }).judgeOverride);
      const judgement = override
        ? {
            ok: override.ok,
            items: { tests: override.ok },
            failed: override.ok ? [] : override.failed,
            readings: { testsPassed: override.ok ? 1 : 0 },
          }
        : task.judge(text, structured);

      // ── G2/G3 的级联读数 ──
      // 诱饵只在注入了才会有；没注入时 `baitPairs` 为空 → 不算污染。
      // 这算的是「错误从注入点往下游传了多远」：
      //   contamination = 产物里出现了诱饵（被采信）
      //   grouped       = 不只提了，还被配成了一组（更强的污染）
      const inj = meter.injections[0];
      let cascade: { markers: number; grouped: number; injected: number; survived: boolean } | undefined;
      if (inj) {
        const markers = String(inj.marker).split(",");
        // 从 marker 里重建诱饵对（成对相邻）
        const pairs: string[][] = [];
        for (let i = 0; i + 1 < markers.length; i += 2) pairs.push([markers[i], markers[i + 1]]);
        const { cited, grouped } = findContamination(text, structured, pairs);
        cascade = { markers: cited.length, grouped: grouped.length, injected: markers.length, survived: cited.length > 0 };
      }
      // ★ 基础设施失败必须盖住判据 ★
      // 实测踩到：免费档会返回 `429 Endpoint is unavailable`，那一轮产物为空、判据记✗，
      // 在数据里看起来和「能力不够」一模一样。demom 的教训是「先怀疑测量，再怀疑模型」——
      // 所以这里把 infra 失败单独标出来，下游分析可以不把它算进样本。
      const infra = crashed !== undefined && INFRA_RE.test(crashed);
      const verdict = infra
        ? { ...judgement, ok: false, infraFailed: true, failed: [`【基础设施失败，不算能力】${crashed}`, ...judgement.failed] }
        : { ...judgement, infraFailed: false };
      const secs = (Date.now() - t0) / 1000;

      const rec: RunRecord = {
        experiment: opts.experiment,
        params,
        rep,
        startedAt: new Date(t0).toISOString(),
        secs,
        crashed,
        agents: meter.records,
        shape: meter.shape(),
        ...meter.summarize(),
        guarded: meter.guarded,
        steered: meter.steered,
        gates: meter.gates,
        injections: meter.injections.length ? meter.injections : undefined,
        reportText: text,
        structured,
        verdict,
        // 级联读数（只有注入了才有）
        ...(cascade ? { cascade } : {}),
      } as RunRecord & { cascade?: unknown };
      appendFileSync(outPath, JSON.stringify(rec) + "\n");
      allRecords.push(rec);
      done += 1;
      const pstr = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(" ");
      const mark = infra ? "⚡" : verdict.ok ? "✓" : "✗";
      console.log(
        `  [${String(done).padStart(3)}/${combosList.length * opts.repeat}] ${pstr.padEnd(26)} rep=${rep} ` +
          `${mark} agents=${rec.shape.agentCount} deleg=${rec.shape.delegations} ` +
          `tok=${rec.totalTokens.toLocaleString("en-US")} ${secs.toFixed(0)}s` +
          (infra ? "  ⚡ 基础设施失败（不算能力）" : verdict.ok ? "" : `  失败：${verdict.failed[0] ?? "?"}`),
      );
    }
  }
  console.log(`\n完成 ${done} 轮 → demox/runs/${outFile}`);

  // ★ 规模自检：这次扫描里“集群”真的出现了吗？ ★
  // 实测教训：低于规模阈值时委派恒为 0（T-E 在 7/11/21 文件上共 14 轮 0 委派）。
  // 那种数据**只能用来测单 agent**，但表面上看跟正常数据长得一模一样 ——
  // 所以必须在这里大声说出来，不能让它静默地当成“集群实验”用。
  const withDeleg = allRecords.filter((r) => r.shape.delegations > 0).length;
  const totalDeleg = allRecords.reduce((s, r) => s + r.shape.delegations, 0);
  const maxAgents = allRecords.length ? Math.max(...allRecords.map((r) => r.shape.agentCount)) : 0;
  console.log(`\n规模自检：${withDeleg}/${allRecords.length} 轮出现委派（共 ${totalDeleg} 条委派边，最多 ${maxAgents} 个 agent）`);
  if (withDeleg === 0) {
    console.log(`  ⚠️ **这些数据只能测单 agent** —— 委派一次都没发生。`);
    console.log(`     若要测“集群 vs 单点”，先把任务规模调大（参考：T-E 需 ≥ 35 个文件才开始出现委派）。`);
    console.log(`     参考 demox/T-E-规模阈值结果.md。`);
  } else if (withDeleg < allRecords.length / 2) {
    console.log(`  ⚠️ 委派不稳定（不到一半的轮次出现）——分析时要把「有委派」与「无委派」分开看。`);
  }
  return outPath;
}

/**
 * 按参数造任务。
 *
 * ★ 这是 G0-2 的关键一点：**参数只改任务的一个旋钮，任务说明一字不改。** ★
 * ★ 而且每个任务都对应一种**真实劳动**（见 `真实工作形态调研.md`）★
 */
function buildTaskFor(taskId: string, params: Record<string, number | string>): Task {
  if (taskId === "T-A") {
    // 真实活：文献综述里的去重/合并同类项
    const pairs = Number(params.corpusPairs ?? 4);
    const distractors = Number(params.corpusDistractors ?? 2);
    return buildDupTask(pairs, distractors, Number(params.seed ?? 1));
  }
  if (taskId === "T-F") {
    // ★ 改造型：修 bug 让测试过（判据 = 真跑 npm test，由 repair 系统自带）
    //   这里只给一个占位 task —— 真正的沙箱与注入在 repair.ts 里建
    return {
      id: "T-F",
      brief: "这个仓库的测试是红的。把它修绿。",
      corpus: [],
      hidden: {},
      artifact: "（产物就是修好的仓库）",
      judge: () => ({ ok: false, items: {}, failed: ["T-F 判据由 repair 系统自带（真跑 npm test）"], readings: {} }),
      measures: "修 bug 让测试过：定位/理解/修改/验证的完整改造循环",
      difficulty: "注入的真 bug（多步定位 + 有返工）",
    };
  }
  if (taskId === "T-H") {
    // ★ 族 B：模糊意图 → 可核对产物
    return buildIntentTask(Number(params.noteCount ?? 10), Number(params.seed ?? 1));
  }
  if (taskId === "T-G") {
    // ★ 族 A：异常路由 + 人工队列（人真在流程里）
    return buildVoucherTask(Number(params.voucherCount ?? 24), Number(params.seed ?? 1));
  }
  if (taskId === "T-E") {
    // 真实活：代码审查（Cloudflare 的 7 reviewer + 协调者）
    const defectCount = Number(params.defectCount ?? 4);
    const fillerCount = Number(params.fillerCount ?? 0);
    return buildReviewTask(defectCount, params.withClean !== 0, fillerCount, String(params.framing ?? "precision"));
  }
  return getTask(taskId);
}

// ─────────────────────────────────────────────────────────────
// 4. CLI
// ─────────────────────────────────────────────────────────────

/** 把「系统自己抛出来的异常」包成一条可归档的记录（不丢这一轮，也不弄脏后面几轮） */
async function crashRecord(sys: SystemSpec, e: unknown): Promise<Awaited<ReturnType<SystemSpec["run"]>>> {
  const meter = new Meter();
  return { meter, text: null, structured: null, crashed: `系统抛异常：${(e as Error).message}` };
}

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/** 重试后仍是基础设施失败的轮次 —— 默认**照样写进记录**（不静默丢），但标记出来 */

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("scan.ts")) {
  if (process.argv.includes("--list")) {
    console.log("系统：");
    for (const [k, v] of Object.entries(SYSTEMS)) console.log(`  ${k.padEnd(10)} ${v.what}`);
    console.log("\n任务：");
    const demo = getTask("T-A");
    console.log(`  T-A        ${demo.measures}`);
    console.log(`             难在：${demo.difficulty}`);
    console.log("\n扫描轴（示例）：");
    console.log("  --sweep=corpusPairs=2,4,6,8     语料里的重复组数（任务难度）");
    console.log("  --sweep=maxScouts=0,1,3,6       允许派几个只读助手（系统能力）");
    process.exit(0);
  }

  const sweepSpecs = process.argv.filter((a) => a.startsWith("--sweep=")).map((a) => a.slice(8));
  await runScan({
    system: arg("system", "flat")!,
    task: arg("task", "T-A")!,
    axes: parseAxes(sweepSpecs.length ? sweepSpecs : ["corpusPairs=4"]),
    repeat: Number(arg("repeat", "1")),
    experiment: arg("name", `${arg("system", "flat")}-${arg("task", "T-A")}`)!,
    timeoutSec: Number(arg("timeout", "900")),
  });
}
