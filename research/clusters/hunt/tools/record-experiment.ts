// record_experiment —— ★★★★★ 把「实验」从**自由文本**变成**结构化对象**
//
// ══════════════════════════════════════════════════════════════════
// ★ 为什么要这一步（2026-10-25 的四个读数，全部实测）
//
//   · 七项缺口：账的列是 `编号·谓词·装置·结局` ⇒ **现象 / 模型 / 猜想 三格根本不存在**
//     ⇒ 它交的是「裁决」（我预期 X，实测 X，成立），不是「发现」
//   · 外部材料 3%（四条灵感叹道里最弱；而死线账 406 · 跨学科 96）
//   · 跨载体成立 12 条 —— 但那是**另立一张账**（`port.jsonl`），与实验账不同源
//   · 链深 ≥3 的项目 2 个 —— 但项目与实验之间**没有键关联**，链深靠人肉写
//
// ★★ 结论：这些不是"要提醒它"的事，是**账的形状**决定的。
//   自由文本账里，没写的格子永远不会出现；写了的也没人核。
//   ⇒ 治法（纪律㉕）：**落在结构上**。实验 = 一个对象，七个字段，其中
//     装置**由工具真跑**（exit code 落账）⇒ 读数不能编；
//     结局=活 却给不出模型 ⇒ **拒收**（没有模型的"活"只是巧合）；
//     外部出处是**必填字段**（外部材料从"灵感通道"变成"实验的属性"）。
//
// ★★★ 能力不是瓶颈（2026-10-25 能力探针，生产 spec，41 秒）：
//   找真论文（arXiv:2508.17536）· 逐字引文（我核过在摘要里）· 写成可判死断言
//   （带反向不死条件）· 设计两载体实验（含 6 条人造答案前置检查）。
//   ⇒ 缺的从来不是能力，是**账装不下它做出来的东西**。
// ══════════════════════════════════════════════════════════════════

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const EXPERIMENTS_FILE = "experiments.jsonl";

export type Outcome = "活" | "死" | "挂起";

export interface CarrierRun {
  dir: string;
  cmd: string;
  exit: number;
  head: string;
}

export interface ExperimentRow {
  at: string;
  by: string;
  /** ★ 与 `PROJECTS.md` 的行号关联 —— 链深靠它算，不靠人肉写 */
  project: string;
  claim: string;
  killCondition: string;
  /** ★ 必填：URL 或 `本仓:<路径>` —— 外部材料是**实验的属性**，不是额外任务 */
  source: string;
  carriers: CarrierRun[];
  /** ★ 现象：可以为空，但空就必须回答"为什么空" */
  phenomenon: string;
  phenomenonAbsent: "" | "没有意外" | "有但没记";
  /** ★ 结局=活 时必填：没模型的"活"只是巧合 */
  model: string;
  conjecture: string;
  outcome: Outcome;
}

export function experimentsPath(lab: string): string {
  return join(lab, "work", EXPERIMENTS_FILE);
}

export function readStructured(lab: string): ExperimentRow[] {
  const p = experimentsPath(lab);
  if (!existsSync(p)) return [];
  const out: ExperimentRow[] = [];
  for (const line of readFileSync(p, "utf8").split(String.fromCharCode(10))) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as ExperimentRow);
    } catch {
      /* 撕裂行：由别的量具计数 */
    }
  }
  return out;
}

export function appendStructured(lab: string, row: ExperimentRow): void {
  mkdirSync(join(lab, "work"), { recursive: true });
  appendFileSync(experimentsPath(lab), JSON.stringify(row) + "\n", "utf8");
}

/**
 * ★★★ 七项齐不齐 —— 现在**由对象保证**，不再靠"账里有没有那一列"。
 * ★ 仍未保证的只有一项：**现象为空但声明了原因**（那也算回答了）。
 */
export interface SevenStats {
  rows: number;
  withPhenomenon: number;
  withModel: number;
  withConjecture: number;
  /** ★ 跨载体成立（≥2 个载体都 exit 0）*/
  portable: number;
  /** 通过 ≥2 载体 + 现象 + 模型 + **结局=活** ⇒ "发现型" */
  discovery: number;
  /**
   * ★★ 反例型：≥2 载体 + 现象 + 模型 + **结局=死**。
   * 为什么单列（集群在 r11 抓到的）：「预期 X，实测 Y ⇒ X 错」**也是**发现，
   * 但把死行算进"发现型"会让那个数**对实验失败不敏感** —— 那正是它自己写的那句：
   * 「自称装『新东西』的计数，对『实验死了』不敏感」。
   */
  refuting: number;
  sources: number;
}

export function sevenStats(rows: readonly ExperimentRow[]): SevenStats {
  const withPhenomenon = rows.filter((r) => r.phenomenon.trim().length > 0).length;
  const withModel = rows.filter((r) => r.model.trim().length > 0).length;
  const withConjecture = rows.filter((r) => r.conjecture.trim().length > 0).length;
  const ok = rows.filter((r) => r.carriers.length >= 2 && r.carriers.every((c) => c.exit === 0)).length;
  const withPhen = (r: ExperimentRow) =>
    r.carriers.length >= 2 && r.carriers.every((c) => c.exit === 0) && !!r.phenomenon.trim() && !!r.model.trim();
  const discovery = rows.filter((r) => withPhen(r) && r.outcome === "活").length;
  const refuting = rows.filter((r) => withPhen(r) && r.outcome === "死").length;
  const sources = rows.filter((r) => !!r.source.trim()).length;
  return { rows: rows.length, withPhenomenon, withModel, withConjecture, portable: ok, discovery, refuting, sources };
}

export function renderSeven(s: SevenStats): string {
  if (s.rows === 0) {
    return (
      "★★★ 结构化实验账：**0 条**（`work/experiments.jsonl` 还没有）—— " +
      "★ 用 `record_experiment` 记：它会**真跑装置**、按七个字段落账，缺格会拒收"
    );
  }
  return (
    `★★★ 结构化实验：**${s.rows} 条** · 现象 ${s.withPhenomenon} · 模型 ${s.withModel} · 猜想 ${s.withConjecture}` +
    ` · **跨载体成立 ${s.portable}** · ★ 发现型 ${s.discovery} · ★★ 反例型 ${s.refuting}` +
    ` · 有出处 ${s.sources}` +
    `　← ★ 「预期 X，实测 Y ⇒ X 错」两种结局都算（发现型=活，反例型=死）；只有"两条都不占"的才是纯裁决`
  );
}

/** ★ cwd 必须在 lab 里面（写边界不变）*/
export function insideLabDir(lab: string, dir: string): boolean {
  const a = resolve(lab).toLowerCase();
  const b = resolve(dir).toLowerCase();
  return b === a || b.startsWith(a + sep);
}

const SOURCE_OK = /^(https?:\/\/|arxiv:|doi:|本仓[:：]|10\.\d{4}\/)/i;

export function validateExperiment(p: {
  project: string;
  claim: string;
  killCondition: string;
  source: string;
  carriers: readonly { dir: string; cmd: string }[];
  phenomenon: string;
  phenomenonAbsent: string;
  model: string;
  outcome: string;
  projectIds: readonly string[];
}): string[] {
  const errs: string[] = [];
  if (p.projectIds.length > 0 && !p.projectIds.includes(p.project)) {
    errs.push(`project「${p.project}」不在 \`PROJECTS.md\` 里（现有：${p.projectIds.join(" · ")}）—— 实验必须挂在项目上，链深才数得出来`);
  }
  if (p.claim.trim().length < 8) errs.push("claim 太短：要写成一句能指回产物的话（≥8 字）");
  if (p.killCondition.trim().length < 8) errs.push("killCondition 太短：写清「若 X 则它错」，否则不是可判死的实验");
  if (!SOURCE_OK.test(p.source.trim())) {
    errs.push("source 必须是 URL / arXiv / DOI / `本仓:<路径>` —— 外部出处是**实验的属性**，不是可选装饰");
  }
  if (p.carriers.length === 0) errs.push("至少要一个载体（carrier），否则读数没有落点");
  for (const c of p.carriers) {
    if (!c.dir.trim()) errs.push("载体少了 dir");
    if (!c.cmd.trim()) errs.push("载体少了 cmd —— 「装置」必须是一条能跑的命令");
  }
  if (!p.phenomenon.trim() && !p.phenomenonAbsent) {
    errs.push(
      "现象为空 ⇒ 必须二选一说明：`没有意外` 或 `有但没记`（★ 这是唯一能装「你没料到的事」的格子，不许静默空着）",
    );
  }
  if (p.outcome === "活" && !p.model.trim()) {
    errs.push("结局=活 但没写 model ⇒ **拒收**：没有机制的「活」只是一次巧合，不是结论");
  }
  return errs;
}

export function makeRecordExperiment(deps: { lab: string; selfKey: string; projectIds: () => string[] }) {
  return defineTool({
    name: "record_experiment",
    label: "Record Experiment",
    description:
      "★ **记一条实验**（这是这个集群的知识单位）。\n" +
      "★★ 它会**真跑你给的装置**（每个载体一条命令），把退出码与输出头落账 —— **读数不能编**。\n" +
      "★ 七个字段：假设 claim / 判死条件 / 装置（carriers 里的 cmd）/ 读数（工具自己抓）/ " +
      "现象 / 模型 / 猜想 / 结局。\n" +
      "★ **缺格会拒收**：`结局=活` 却没写 `model` 会被拒（没有机制的活只是巧合）；" +
      "现象空着必须二选一说明理由。\n" +
      "★ `source` 是必填：URL / arXiv / DOI / `本仓:<路径>` —— 外部出处是**实验的属性**。\n" +
      "★ `project` 必须是 `PROJECTS.md` 里已有的行号 —— 链深靠这个键算，不靠人肉写。",
    parameters: Type.Object({
      project: Type.String({ description: "★ 挂在哪个项目上（`PROJECTS.md` 的行代号，例如 X2）" }),
      claim: Type.String({ description: "假设（一句话，能指回产物/结论）" }),
      killCondition: Type.String({ description: "★ 判死条件：若观察到 X，则这条假设错" }),
      source: Type.String({ description: "★ 出处：URL / arXiv:xxxx / DOI / `本仓:<路径>`" }),
      carriers: Type.Array(
        Type.Object({
          dir: Type.String({ description: "★ 载体目录（相对本 lab，例如 work/lab-A）" }),
          cmd: Type.String({ description: "★ 在这个载体里跑的命令（这就是「装置」）" }),
        }),
        { description: "1–3 个载体。★ 两个以上载体都 exit 0 才算「跨载体成立」" },
      ),
      phenomenon: Type.String({ description: "★ 现象：实测**与你预期不一样**的地方（写不出就留空并在下面说明）" }),
      phenomenonAbsent: Type.Union([Type.Literal(""), Type.Literal("没有意外"), Type.Literal("有但没记")], {
        description: "★ phenomenon 为空时必填：这次真没有意外，还是有但你没记？",
      }),
      model: Type.String({ description: "★ 模型/机制：为什么会得到这个读数（结局=活 时必填）" }),
      conjecture: Type.String({ description: "猜想：这条读数指向的下一个可验证问题（可空）" }),
      outcome: Type.Union([Type.Literal("活"), Type.Literal("死"), Type.Literal("挂起")], {
        description: "结局：活（假设没被推翻）/ 死（被推翻，说清死因）/ 挂起（缺什么证据）",
      }),
    }),
    execute: async (_id, p) => {
      const errs = validateExperiment({ ...p, projectIds: deps.projectIds() });
      if (errs.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "⛔ 拒收（补完再交，别改成自由文本绕过去）：\n" + errs.map((e) => `  · ${e}`).join("\n"),
            },
          ],
          details: {},
        };
      }
      // ★ 真跑装置
      const runs: CarrierRun[] = [];
      const problems: string[] = [];
      for (const c of p.carriers) {
        const dir = c.dir.startsWith("/") || /^[A-Za-z]:/.test(c.dir) ? c.dir : join(deps.lab, c.dir);
        if (!insideLabDir(deps.lab, dir)) {
          problems.push(`载体 ${c.dir} 不在本 lab 里面（写边界不变）`);
          continue;
        }
        let exit = 0;
        let out = "";
        try {
          out = execFileSync("bash", ["-lc", c.cmd], {
            cwd: dir,
            encoding: "utf8",
            timeout: 240_000,
            maxBuffer: 8 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (e) {
          const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
          exit = typeof err.status === "number" ? err.status : 1;
          out = `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`;
        }
        runs.push({ dir: c.dir, cmd: c.cmd, exit, head: out.slice(0, 600) });
      }
      if (problems.length > 0) {
        return {
          content: [{ type: "text" as const, text: "⛔ " + problems.join("；") }],
          details: {},
        };
      }
      const row: ExperimentRow = {
        at: new Date().toISOString(),
        by: deps.selfKey,
        project: p.project,
        claim: p.claim,
        killCondition: p.killCondition,
        source: p.source,
        carriers: runs,
        phenomenon: p.phenomenon,
        phenomenonAbsent: p.phenomenonAbsent as ExperimentRow["phenomenonAbsent"],
        model: p.model,
        conjecture: p.conjecture,
        outcome: p.outcome,
      };
      appendStructured(deps.lab, row);
      const s = sevenStats(readStructured(deps.lab));
      const portable = runs.length >= 2 && runs.every((r) => r.exit === 0);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `✔ 已落账（\`work/experiments.jsonl\`）· ${runs.length} 个载体：\n` +
              runs.map((r) => `  · ${r.dir} ⇒ exit **${r.exit}**`).join("\n") +
              `\n\n★ 跨载体成立：**${portable ? "是" : "否"}**（要 ≥2 个载体都 exit 0）` +
              `\n★ 全账：${s.rows} 条 · 发现型 ${s.discovery} · 跨载体成立 ${s.portable}` +
              (s.discovery === 0
                ? "\n★★ 现在账里 **0 条发现型**（跨载体 + 现象 + 模型）—— 裁决不是发现。"
                : ""),
          },
        ],
        details: {},
      };
    },
  });
}
