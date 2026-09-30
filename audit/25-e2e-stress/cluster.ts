// 25-e2e-stress 共用：真任务定义 + 11 个异构成员 + 全程时间线/用量记录。
// 设计目标：回答「用这个框架跑一个真实 8-10 人团队任务，实际会发生什么」。
//
// 拓扑（4 层）：
//   顶层主持人 host (0)
//     ├─ lead_cap (1) ─ sub_cap (2) ─┬─ src_reader (3)
//     │                              └─ code_probe (3)
//     ├─ lead_limit (1) ─ sub_limit (2) ─┬─ audit_reader (3)
//     │                                  └─ doc_reader (3)
//     ├─ reviewer (1)
//     └─ writer (1, cwd=输出目录)
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createAgent, createAgentHost, type AgentHost, type MemberSpec } from "../../src/index.ts";

export const REPO = "D:/space/aiteam/test";
export const SRC = join(REPO, "src");

export const FLASH = "opencode-go/deepseek-v4.1-flash";
export const QWEN = "opencode-go/qwen3.8-flash";
export const MIMO = "opencode-go/mimo-v2.6-flash";
export const GLM = "opencode-go/glm-5.3-flash";
export const PRO = "opencode-go/deepseek-v4-pro";

// ── 一个真工具（真读盘、返回真数字），用来让交付物里带「实测输出」而不是模型编的数字 ──
export const probeMetrics = defineTool({
  name: "probe_metrics",
  label: "仓库度量",
  description: "测量本仓库 src/ 下每个 .ts 文件的行数，并返回 package.json 的依赖名。无参数。",
  parameters: Type.Object({}),
  execute: async () => {
    const dir = join(REPO, "src", "agent");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    const lines = files.map((f) => `${f}=${readFileSync(join(dir, f), "utf-8").split("\n").length}`);
    const total = lines.reduce((a, l) => a + Number(l.split("=")[1]), 0);
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf-8"));
    const text = `src/agent 文件行数：${lines.join(" ")}（合计 ${total} 行）；依赖：${Object.keys(pkg.dependencies).join(", ")}`;
    return { content: [{ type: "text" as const, text }], details: {} };
  },
});

const LEAD_PROTOCOL =
  "你的工作流固定为两步：第一步只用一条消息发起 spawn_agent 把调研派给 sub 成员（task 原文写「按你的角色说明完成两个组员的调研，并把它们的返回原样合并后交回」）；" +
  "第二步拿回结果后，写一份 200 字以内的组内小结，并且必须以【CAP-组小结】或【LIMIT-组小结】开头（按你属于哪一组）。";
export const CLARIFY_TAG = "【澄清回复】";

export function memberSpecs(): Record<string, MemberSpec> {
  return {
    lead_cap: {
      description: "能力组组长：带一个副组长和两名组员，调研框架「能做什么」",
      role: `你是能力组组长，负责调研框架的能力面。${LEAD_PROTOCOL} 若收到额外追加消息，回复必须以${CLARIFY_TAG}开头。`,
      model: FLASH,
      tools: ["spawn_agent", "send_message", "read"],
    },
    lead_limit: {
      description: "极限组组长：带一个副组长和两名组员，调研框架「哪里会崩」",
      role: `你是极限组组长，负责调研框架的极限面。${LEAD_PROTOCOL} 若收到额外追加消息，回复必须以${CLARIFY_TAG}开头。`,
      model: QWEN,
      tools: ["spawn_agent", "send_message", "read"],
    },
    sub_cap: {
      description: "能力组副组长：把两个组员的产出合并，然后交回组长",
      role:
        "你是能力组副组长。你的工作流：只用一条消息同时发起两个 spawn_agent 调用，member 分别是 src_reader 与 code_probe，" +
        "task 都写「按你的角色说明完成你的那一小块调研，然后交回结论」。拿回两份结论后，把它们原样合并（保留文件:行号与命令输出），再用 3 句话总结，直接交回。",
      model: MIMO,
      tools: ["spawn_agent", "read"],
    },
    sub_limit: {
      description: "极限组副组长：把两个组员的产出合并，然后交回组长",
      role:
        "你是极限组副组长。你的工作流：只用一条消息同时发起两个 spawn_agent 调用，member 分别是 audit_reader 与 doc_reader，" +
        "task 都写「按你的角色说明完成你的那一小块调研，然后交回结论」。拿回两份结论后，把它们原样合并（保留证据编号），再用 3 句话总结，直接交回。",
      model: GLM,
      tools: ["spawn_agent", "read"],
    },
    src_reader: {
      description: "代码读者：只读 src/ 下的实现，给出带 文件:行号 的能力证据",
      role:
        "你在 src/ 目录下工作，只能相对路径读文件。读 agent/create-agent.ts 与 tools/spawn-agent.ts，" +
        "给出 2 条「框架确实实现了什么」的证据，每条必须写成 文件名:行号 的形式，并附一句原文片段（不超过 20 字）。200 字以内。",
      model: QWEN,
      tools: ["read"],
      cwd: SRC,
    },
    code_probe: {
      description: "实测员：用真工具测真数字，不做推测",
      role:
        "你是实测员，禁止推测。必须调用 probe_metrics 工具拿到真实数字，把原始输出原样贴出来，再补一句解释。150 字以内。",
      model: PRO,
      tools: ["read", "bash"],
      customTools: [probeMetrics],
    },
    audit_reader: {
      description: "审计读者：读 audit/verification-of-report.md 的 K 节，给出风险证据",
      role:
        "只读 audit/verification-of-report.md，找到 K 节（RunResult 串台）。用 3 句话说明：症状是什么、打中哪个原语、设计者靠什么发现不了。必须引用 K 节原文的少量字样。250 字以内。",
      model: MIMO,
      tools: ["read"],
    },
    doc_reader: {
      description: "文档读者：读 docs/research 报告第九部分，给出地基缺口证据",
      role:
        "只读 docs/research/2026-09-30-phase1-capability-audit-report.md 的「第九部分：地基缺口清单」。挑出你认为对「跑一个 8-10 人真实团队」影响最大的 2 条缺口，每条写明排序号与缺口名。200 字以内。",
      model: GLM,
      tools: ["read"],
    },
    reviewer: {
      description: "审查员：对两份组内小结挑错，只讲问题与要改什么",
      role:
        "你是审查员。你会收到两份组内小结。只输出 3 条「要求修改」的具体意见，每条 20 字以内，必须指到某一份小结里的某句话。不要夸奖，不要复述。",
      model: FLASH,
      tools: ["read"],
    },
    writer: {
      description: "写手：把最终内容写成 report.md 落盘，不参与争论",
      role:
        "你是写手，只负责落盘。把交办的内容整理成 markdown 写进文件 report.md（相对路径，当前目录就是输出目录），" +
        "必须包含四个二级标题：## 能力证据 / ## 风险证据 / ## 实测输出 / ## 审查意见处理。写完只回一句确认，并原样回显文件的一级标题行。",
      model: FLASH,
      tools: ["read", "write"],
      cwd: process.env.AITEAM_STRESS_OUT || REPO,
    },
  };
}

export const HOST_ROLE =
  "你是顶层主持人，只做三件事：挑人、派活、收集。你的第 1 轮必须只用一条消息同时发起两个 spawn_agent 调用，" +
  "member 分别是 lead_cap 与 lead_limit，两次的 task 都写「按你的角色说明完成你负责那一面的调研，然后交回小结」。你自己不写小结。";

export const R1_TASK =
  "现在开始第 1 轮：按你的角色说明，用一条消息同时发起两个 spawn_agent 调用（lead_cap 与 lead_limit），把两面的调研同时派出去。等两个都返回后，把两份小结原样贴出来，不要改写。";

// ── 全程记录器 ───────────────────────────────────────────────
export interface Trace {
  runId: string;
  startedAt: number;
  events: Array<{ t: number; kind: string; agent?: string; member?: string; detail: string }>;
  rounds: Array<{ t: number; agent: string; member?: string; ms: number; roundStart: number; tokens: number; cost: number; error: string | null; textHead: string; assignedMs: number }>;
}

export function makeTracer(runId: string): Trace {
  return { runId, startedAt: Date.now(), events: [], rounds: [] };
}

export function attachTracer(host: AgentHost, tr: Trace): void {
  const at = () => Date.now() - tr.startedAt;
  const spawnStart = new Map<string, number>();
  const lastEnd = new Map<string, number>();
  host.on("agent_created", ({ agent, member, parent }) => {
    spawnStart.set(agent.id, Date.now());
    tr.events.push({ t: at(), kind: "created", agent: agent.id, member: member ?? undefined, detail: `parent=${parent?.id ?? "-"}` });
  });
  host.on("round_completed", ({ agent, result }) => {
    const now = Date.now();
    const start = lastEnd.get(agent.id) ?? spawnStart.get(agent.id) ?? now;
    lastEnd.set(agent.id, now);
    tr.rounds.push({
      t: at(),
      agent: agent.id,
      member: agent.member,
      ms: now - start,
      roundStart: start - tr.startedAt,
      tokens: result.usage.totalTokens,
      cost: Number(result.usage.cost.total.toFixed(6)),
      error: result.error ?? null,
      textHead: (result.text ?? "").replace(/\s+/g, " ").slice(0, 120),
      assignedMs: now - tr.startedAt,
    });
  });
  host.on("agent_disposed", ({ agent }) => {
    tr.events.push({ t: at(), kind: "disposed", agent: agent.id, member: agent.member ?? undefined, detail: "" });
  });
}

export async function buildTeam(opts: { outDir: string; maxAgents?: number; budgetTokens?: number }) {
  const members = memberSpecs();
  const host = createAgentHost({ members, maxAgents: opts.maxAgents ?? 20, maxDepth: 3, budgetTokens: opts.budgetTokens });
  const tr = makeTracer(opts.outDir);
  attachTracer(host, tr);
  const top = await createAgent({ model: FLASH, role: HOST_ROLE, tools: ["spawn_agent", "send_message"] }, { host, member: "host" });
  top.on("error", (e) => tr.events.push({ t: Date.now() - tr.startedAt, kind: "agent_error", agent: top.id, detail: String((e as any).message ?? e) }));
  return { host, top, tr, members, outDir: opts.outDir };
}

/** 从 session.messages 里把某个角色的文本全取出来（用于「模型实际收到了什么」） */
export function toolResultTexts(session: any): string[] {
  const out: string[] = [];
  for (const m of session.messages ?? []) {
    if (m.role !== "toolResult" && m.role !== "tool") continue;
    const c = m.content;
    if (Array.isArray(c)) out.push(c.filter((x: any) => x.type === "text").map((x: any) => x.text).join(""));
    else if (typeof c === "string") out.push(c);
  }
  return out;
}

export function toolCalls(session: any): Array<{ name: string; input: any }> {
  const out: Array<{ name: string; input: any }> = [];
  for (const m of session.messages ?? []) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c.type === "toolCall" || c.type === "tool_use") out.push({ name: c.name, input: c.input ?? c.arguments });
    }
  }
  return out;
}

export function assistantTexts(session: any): string[] {
  const out: string[] = [];
  for (const m of session.messages ?? []) {
    if (m.role !== "assistant") continue;
    const c = m.content;
    if (Array.isArray(c)) {
      const t = c.filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
      if (t) out.push(t);
    }
  }
  return out;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const short = (s: string | undefined, n = 100) => (s ?? "(空)").replace(/\s+/g, " ").slice(0, n);
export const findMember = (host: AgentHost, name: string) => host.list().find((a) => a.member === name);

/** 落盘验收：writer 到底有没有写出文件，内容里有没有必备要素 */
export function inspectReport(outDir: string) {
  const p = join(outDir, "report.md");
  try {
    const text = readFileSync(p, "utf-8");
    return {
      exists: true,
      path: p,
      bytes: statSync(p).size,
      headings: text.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.trim()),
      hasCapTag: text.includes("【CAP-组小结】"),
      hasLimitTag: text.includes("【LIMIT-组小结】"),
      hasClarifyTag: text.includes(CLARIFY_TAG),
      hasMetrics: text.includes("src/agent 文件行数"),
      text,
    };
  } catch {
    return { exists: false, path: p, bytes: 0, headings: [] as string[], hasCapTag: false, hasLimitTag: false, hasClarifyTag: false, hasMetrics: false, text: "" };
  }
}
