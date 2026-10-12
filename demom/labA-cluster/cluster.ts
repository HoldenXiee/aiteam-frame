// 实验室 A：自由集群 —— 花名册、工具、预算闸。
//
// 设计理由见同目录 README.md，这里只落代码。三条要点：
//   ① 花名册是**使用者代码**（一个 Map），库里没有花名册这个概念（examples/09-roster.ts 同一个位置）；
//   ② `spawn` 是唯一的派活口，role 必须命中花名册，子 agent **也拿到 spawn** —— 递归真的可能发生；
//   ③ 终止条件 = **token 预算 + 允许已派出的活收尾**（README §4，研究员已点头的那个方案）。

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lab, MODEL, cwd } from "../env.ts";
import { DRAFT_DIR } from "../bench/task.ts";
import type { AgentTool, Agent, AgentMessage } from "../../src/index.ts";

// ─────────────────────────────────────────────────────────────
// 花名册（README §2 的四张面孔）
// ─────────────────────────────────────────────────────────────
export interface Member {
  role: string;
  /** 工具白名单：**精确就是这些**（permissions.only） */
  tools: string[];
}

export const ROSTER = new Map<string, Member>([
  [
    "scout",
    {
      role:
        "摸底员：读**交给你那部分**材料（如果派活的人没限定范围，就是 corpus/ 里的全部），报告三件事——" +
        "哪几份在讲同一件事（重复）、哪几份对同一件事给出相反结论（矛盾）、哪几份与 T1–T5 五个主题都无关。你只负责摸清楚，不写报告。",
      tools: ["read", "note", "list_corpus"],
    },
  ],
  [
    "analyst",
    {
      role:
        "分析员：针对交办给你的**那一个**主题，从材料里提炼依据，每条标出材料编号。只处理被指派的主题，不写最终报告。",
      tools: ["read", "note"],
    },
  ],
  [
    "checker",
    {
      role:
        "核查员：拿 draft/ 里的成果逐条核——编号是不是编的、重复有没有漏、矛盾有没有成对。你**只读不改**，发现问题就报告，不要自己动手改。",
      tools: ["read"],
    },
  ],
  [
    "writer",
    {
      role:
        "写手：读 draft/ 里的全部片段，按 T1–T5 分节拼成 report.md。每节标题以「## 」开头，节末单独一行写依据编号。你是**唯一**能落盘的人。",
      tools: ["read", "write", "note"],
    },
  ],
]);

// ─────────────────────────────────────────────────────────────
// 预算闸（README §4）—— 终止条件
// ─────────────────────────────────────────────────────────────
/** token 预算：所有分身累计。超了就拒绝新的 spawn，**已派出的活跑完**（不打断）。 */
export const TOKEN_BUDGET = 400_000;

export interface Budget {
  spent: number;
  hit: boolean;
  /** 累计用量怎么读：每个 agent 交进来，按全生命周期累计 */
  note(agentId: string, tokens: number): void;
}

export function newBudget(): Budget {
  const seen = new Map<string, number>();
  return {
    spent: 0,
    hit: false,
    note(agentId, tokens) {
      const prev = seen.get(agentId) ?? 0;
      seen.set(agentId, tokens);
      this.spent += tokens - prev; // 累计值，取增量，避免重复计数
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

/** 让模型能自己看一眼材料清单（不靠猜有哪些文件） */
export const listCorpus: AgentTool = defineTool({
  name: "list_corpus",
  label: "List Corpus",
  description: "列出 corpus/ 目录里的全部材料编号与标题。想知道有多少份材料时用它。",
  parameters: Type.Object({}),
  execute: async () => {
    const dir = join(cwd, "corpus");
    const names = readdirSync(dir).filter((f) => f.endsWith(".md"));
    return {
      content: [{ type: "text" as const, text: names.length ? names.join("\n") : "corpus/ 是空的" }],
      details: { count: names.length },
    };
  },
});

/**
 * 交片段：把自己的结论追加进 draft/<name>.md。
 *
 * 走文件是**与 B 约定的共同规矩**（两份 README §中间产物），不能一边走文件一边走内存。
 */
export function noteTool(who: string): AgentTool {
  return defineTool({
    name: "note",
    label: "Note",
    description: `把一段结论追加记进中间产物 draft/${who}.md。交给下游的成果必须用这个工具落下来，否则别人看不到。`,
    parameters: Type.Object({
      text: Type.String({ description: "要记下的内容（Markdown）" }),
    }),
    execute: async (_id, p) => {
      const { appendFileSync, mkdirSync } = await import("node:fs");
      const dir = join(cwd, DRAFT_DIR);
      mkdirSync(dir, { recursive: true });
      const f = join(dir, `${who}.md`);
      appendFileSync(f, `\n## [$who]\n${p.text}\n`, "utf8");
      return {
        content: [{ type: "text" as const, text: `已追加进 draft/${who}.md（${p.text.length} 字符）` }],
        details: { file: f, chars: p.text.length },
      };
    },
  });
}

/** 派活的证据记录（跑完打印，进 runs/） */
export interface SpawnLog {
  role: string;
  task: string;
  depth: number;
  accepted: boolean;
  reason?: string;
  childId?: string;
}

// ─────────────────────────────────────────────────────────────
// ★ 通讯录 + 双向通信（库的高级功能：自定义工具做 agent 直接通信）★
//
// 背景（这是本实验的第六轮，也是被质疑后补的）：
//   原来的集群只有 `spawn` —— **单向派活**。派出去之后，子 agent 交回一段文本，
//   父 agent **没办法再问它**，子 agent 之间更是完全不知道对方存在。
//
//   而库允许把**任意函数**包成工具。于是「agent 之间直接说话」不需要库内置什么机制，
//   只需要一个共享的通讯录 + 一个会去调对方 `io.prompt` 的工具。
//
//   这也直接对应 B 的 share 实验：那边是**沿图传上下文**，这边是**按需去问**。
// ─────────────────────────────────────────────────────────────

export interface PeerEntry {
  id: string;
  role: string;
  task: string;
  agent: Agent;
}

export interface Registry {
  peers: Map<string, PeerEntry>;
  add(entry: PeerEntry): void;
  list(): PeerEntry[];
  /** 被问了多少次（跑完进数据，看这个机制到底有没有被用上） */
  asked: { from: string; to: string; question: string }[];
}

export function newRegistry(): Registry {
  const peers = new Map<string, PeerEntry>();
  const asked: { from: string; to: string; question: string }[] = [];
  return {
    peers,
    asked,
    add(entry) {
      peers.set(entry.id, entry);
    },
    list() {
      return [...peers.values()];
    },
  };
}

/** 通讯录：看集群里还有谁，可以问谁 */
export function peersTool(registry: Registry, selfId: string): AgentTool {
  return defineTool({
    name: "peers",
    label: "Peers",
    description: "列出集群里**其他**已知的 agent（id + 角色 + 它在干什么）。列出来的都可以用 ask 直接问。",
    parameters: Type.Object({}),
    execute: async () => {
      const others = registry.list().filter((p) => p.id !== selfId);
      const text = others.length
        ? others.map((p) => `· ${p.id}（${p.role}）—— 它在做：${p.task.slice(0, 80)}`).join("\n")
        : "（暂时没有别人；你派出去的 agent 会出现在这里）";
      return { content: [{ type: "text" as const, text }], details: { count: others.length } };
    },
  });
}

/**
 * ★ `ask`：向集群里另一个 agent **直接提问** ★
 *
 * 与 `spawn` 的区别（这是这个变体要检验的东西）：
 *   · `spawn` 是**新建**一个 agent 并把活交出去（单向、有去无回）
 *   · `ask` 是**问一个已经在场的** agent（双向、可追问）
 *
 * 两个安全阀：
 *   ① 对方忙（status !== "idle"）就拒绝，不排队 —— 否则 A 问 B、B 问 A 会**死锁**；
 *   ② 计入同一个预算闸，否则「问」会成为绕过预算的后门。
 */
export function askTool(opts: {
  registry: Registry;
  selfId: string;
  budget: Budget;
  log: SpawnLog[];
}): AgentTool {
  return defineTool({
    name: "ask",
    label: "Ask",
    description:
      "向集群里另一个**已经在场**的 agent 直接问一个问题，拿它的回答。" +
      "用 peers 工具看有哪些人可以问。适合追问、对账、让它确认一件事。",
    parameters: Type.Object({
      peer: Type.String({ description: "对方的 id（用 peers 工具查）" }),
      question: Type.String({ description: "你要问它什么" }),
    }),
    execute: async (_id, p) => {
      const t = opts.registry.peers.get(p.peer);
      if (!t) {
        return {
          content: [{ type: "text" as const, text: `没有这个 peer：${p.peer}。用 peers 工具看有哪些。` }],
          details: {},
        };
      }
      if (t.agent.status !== "idle") {
        // 不排队：排队会在 A 问 B / B 问 A 时死锁
        return {
          content: [{ type: "text" as const, text: `${p.peer} 正在忙，现在问不了。用你已经知道的信息继续，或稍后再试。` }],
          details: { busy: true },
        };
      }
      if (opts.budget.spent >= TOKEN_BUDGET) {
        opts.budget.hit = true;
        return {
          content: [{ type: "text" as const, text: `拒绝：token 预算已用完（${opts.budget.spent}/${TOKEN_BUDGET}），不要再问了。` }],
          details: {},
        };
      }
      opts.registry.asked.push({ from: opts.selfId, to: p.peer, question: p.question });
      const res = await t.agent.io.prompt(p.question);
      opts.budget.note(t.agent.id, t.agent.usage.totalTokens);
      const body = res.error ? `对方这一轮失败：${res.error}` : res.text;
      return {
        content: [{ type: "text" as const, text: `【${t.id} 回答】\n${body}` }],
        details: { peer: p.peer },
      };
    },
  });
}

/** 把一个 agent 的**上下文轨迹**渲染成可放进工具结果的文本（轨迹共享） */
export function traceToText(agent: Agent, limit = 40_000): string {
  const msgs: AgentMessage[] = agent.context.history.filter((m) => m.role !== "system");
  const parts: string[] = [];
  for (const m of msgs) {
    const c = "content" in m ? m.content : "";
    const text =
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? (c as { type?: string; text?: string }[])
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("")
          : "";
    if (text.trim()) parts.push(`[${m.role}] ${text}`);
  }
  const body = parts.join("\n\n");
  return body.length > limit ? body.slice(0, limit) + `\n…（轨迹已截断，原长 ${body.length} 字符）` : body;
}

/**
 * `spawn`：唯一的派活口。
 *
 * 递归是真的：子 agent 拿到的 spawn 深度 +1，所以预算闸不是摆设。
 * 深度上限只是**防失控的兜底**（真正的闸是预算），设得比较宽松，免得替模型做决定。
 */
export function spawnTool(opts: {
  depth: number;
  budget: Budget;
  log: SpawnLog[];
  meterWatch: (agent: import("../../src/index.ts").Agent, meta: { role: string; parent: string | null; depth: number }) => void;
  parentId: string;
  /** 通讯录（talk 变体才有）：子 agent 一创建就登记，于是别人能 ask 它 */
  registry?: Registry;
  /**
   * 轨迹共享（talk 变体才有）：把子 agent 的**完整上下文轨迹**交回给派活的人，
   * 而不只是它写下的那段结论。
   *
   * 这是 B/share 在集群里的对应物 —— B 那边是 `context.override` 注入，
   * 这边是**工具结果里带着轨迹**。两者都是「合流」而不是「重建」。
   */
  traceShare?: boolean;
  /** ask 工具（talk 变体才有）：传给子 agent，让它也能横向问别人 */
  extraTools?: (childId: string, childRole: string) => AgentTool[];
}): AgentTool {
  const MAX_DEPTH = 5;
  // createAgent 之后才有真 id，但 extraTools 要在 createAgent 之前构好 —— 用个盒子传递
  const childIdHolder = { id: "" };
  return defineTool({
    name: "spawn",
    label: "Spawn",
    description:
      "从花名册里挑一个角色，把一件活派给它，拿它的文本结果。可选角色：" +
      [...ROSTER.keys()].join("、") +
      "。派出去的活会真的起一个新 agent 去做。",
    parameters: Type.Object({
      role: Type.String({ description: `花名册里的角色名：${[...ROSTER.keys()].join(" / ")}` }),
      task: Type.String({ description: "要交给它做的具体事情" }),
    }),
    execute: async (_id, p) => {
      const member = ROSTER.get(p.role);
      if (!member) {
        const reason = `拒绝：花名册里没有「${p.role}」这个角色。可选：${[...ROSTER.keys()].join("、")}`;
        opts.log.push({ role: p.role, task: p.task, depth: opts.depth, accepted: false, reason });
        return { content: [{ type: "text" as const, text: reason }], details: {} };
      }
      if (opts.depth >= MAX_DEPTH) {
        const reason = `拒绝：委派深度 ${opts.depth} 已达上限 ${MAX_DEPTH}，不再往下派。`;
        opts.log.push({ role: p.role, task: p.task, depth: opts.depth, accepted: false, reason });
        return { content: [{ type: "text" as const, text: reason }], details: {} };
      }
      // ★ 预算闸：超了就拒绝**新的**派活，已派出的活跑完（README §4）★
      if (opts.budget.spent >= TOKEN_BUDGET) {
        opts.budget.hit = true;
        const reason = `拒绝：token 预算已用完（${opts.budget.spent}/${TOKEN_BUDGET}）。就现有材料收尾，不要再派活。`;
        opts.log.push({ role: p.role, task: p.task, depth: opts.depth, accepted: false, reason });
        return { content: [{ type: "text" as const, text: reason }], details: {} };
      }

      // 子 agent 也拿到 spawn（深度 +1）—— 递归真的可能发生
      const child = await lab.createAgent({
        model: MODEL,
        role: `${member.role}\n\n你的名字：${p.role}。`,
        permissions: { only: member.tools },
        tools: {
          custom: [
            listCorpus,
            noteTool(`${p.role}`),
            spawnTool({ ...opts, depth: opts.depth + 1 }),
            ...(opts.extraTools ? opts.extraTools(childIdHolder.id, p.role) : []),
          ],
        },
      });
      opts.meterWatch(child, { role: p.role, parent: opts.parentId, depth: opts.depth + 1 });
      childIdHolder.id = child.id; // extraTools 需要真 id，而 id 要 createAgent 之后才有
      opts.registry?.add({ id: child.id, role: p.role, task: p.task, agent: child });
      opts.log.push({ role: p.role, task: p.task, depth: opts.depth, accepted: true, childId: child.id });

      const res = await child.io.prompt(p.task);
      // 把子 agent 的用量记进预算（全生命周期累计）
      opts.budget.note(child.id, child.usage.totalTokens);

      const body = res.error ? `子 agent 这一轮失败：${res.error}` : res.text;
      // ★ 轨迹共享：把「它读过什么、怎么想的」一并交回去，而不只是它的结论 ★
      const trace = opts.traceShare ? `\n\n【它看过的内容与推理过程】\n${traceToText(child)}` : "";
      return {
        content: [{ type: "text" as const, text: `【${p.role} 交回】\n${body}${trace}` }],
        details: { childId: child.id, traced: opts.traceShare === true },
      };
    },
  });
}

/** 把中间产物目录读进来（供父 agent 汇总；也给 run.ts 打印用） */
export function readDrafts(): string {
  const dir = join(cwd, DRAFT_DIR);
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    return files.map((f) => `\n===== ${f} =====\n${readFileSync(join(dir, f), "utf8")}`).join("\n");
  } catch {
    return "（draft/ 里什么都没有）";
  }
}

/** 环境扩展：给集群里的 agent 提供「读全部草稿」的能力（只有 writer 用得上） */
export function draftsExtension(): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI) => {
    pi.registerTool(
      defineTool({
        name: "read_drafts",
        label: "Read Drafts",
        description: "读中间产物目录 draft/ 里的全部片段。汇总成文前用它把上游成果看一遍。",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text" as const, text: readDrafts() }], details: {} }),
      }),
    );
  };
}
