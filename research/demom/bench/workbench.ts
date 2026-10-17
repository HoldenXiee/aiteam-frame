// 工作台（Workbench）—— 用库的底层原语造的一个构件，不是「某个功能的用法示例」。
//
// ═══════════════════════════════════════════════════════════════════
// 它要解决的两个问题（都来自实验数据，不是想象）
// ═══════════════════════════════════════════════════════════════════
//
// 问题 1：**交接有损**（研究记录 §4）
//   实测：A/nodup（集群）与 B/base（流程）**是同一种失败** ——
//   判断者看不见原始材料、且只能靠自由文本交接 → 去重 0/2 与 2/4。
//   而「合流」（共享上下文）是唯一稳定有效的做法：
//     · A/base 靠「不分离」4/6
//     · B/share 靠 `context.override` 注入轨迹 6/8
//
// 问题 2：**合流很贵**
//   实测：B/share 注入 ~100k 字符，S4 的上下文被撑大；
//   B/verify 让 S2 重读 45 份原文，token 1004k（是 share 的 1.8 倍）。
//   根因：**原始材料被反复搬运** —— 读一遍、传一遍、再读一遍。
//
// ═══════════════════════════════════════════════════════════════════
// 做法：把「原始材料」换成「结构化结论」，并且让它**全局可见**
// ═══════════════════════════════════════════════════════════════════
//
//   ① **黑板**：所有 agent 共享一份结构化状态（不是自由文本）。
//      每轮通过 `context.override` 注进**每一个** agent 的请求 —— 这是「合流」，
//      但注入的是**提炼过的结论**，不是原始材料，所以便宜。
//
//   ② **读后即消化**：agent 用 `post` 工具把结论写进黑板之后，
//      代码把那条**原始 read 的上下文条目 erase 掉** ——
//      原文不再占上下文，知识留在黑板上。
//      （对应人的做法：读完做笔记，原文不必一直摊在桌上。）
//
//   ③ **代码守住不变量**：写进黑板的东西在**写入时**就被代码校验
//      （编号必须存在、重复组至少两个成员、矛盾必须成对）。
//      模型负责判断，代码负责保真 —— 与 B 的 S6 同一条分工。
//
// ═══════════════════════════════════════════════════════════════════
// 用了哪些库原语（每一个都是必需的，不是炫技）
// ═══════════════════════════════════════════════════════════════════
//   `context.override`   每轮注入黑板（不改历史）
//   `context.entries()`  拿到可寻址的条目（为了 erase）
//   `context.erase`      读后即消化：把原始 read 移出上下文
//   `context.usage`      预算管理的读数
//   自定义工具           `post` —— agent 往黑板写结构化结论
//   `on("tool_call")`    知道它读了哪一份（才知道能消化什么）
//
// ⚠️ 一个刻意的边界：黑板**不包含**任何 ground truth。
//    重复组是 agent 自己判出来的（那是任务难点）；代码只保证「它写下来的
//    结构合法、且所有人都看得见」，不保证「它判得对」。

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Agent, AgentMessage, AgentTool } from "../../../src/index.ts";
import { cwd } from "../env.ts";

/** 黑板上的材料编号全集（用于校验，**不是**答案） */
function corpusIds(): Set<string> {
  try {
    return new Set(
      readdirSync(join(cwd, "corpus"))
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.split("-")[0].toUpperCase()),
    );
  } catch {
    return new Set();
  }
}

export interface BoardEntry {
  topic: string;
  fact: string;
  ids: string[];
}

export interface BoardState {
  /** 材料编号 → 一句话要点（读过就记下来） */
  notes: Record<string, string>;
  /** 重复组：agent 判定的「同一件事」 */
  dupGroups: string[][];
  /** 矛盾对 */
  contradictions: { pair: [string, string]; note: string }[];
  /** 与主题无关、已排除 */
  excluded: string[];
  /** 成文条目 */
  entries: BoardEntry[];
}

export interface Workbench {
  state: BoardState;
  /** 每轮注入的黑板文本（给 override 用） */
  render(): string;
  /** agent 往黑板上写的工具 */
  postTool(selfId: string): AgentTool;
  /** 给一个 agent 挂上：注入黑板 + 读后即消化 */
  attach(agent: Agent, selfId: string): void;
  /** 落进数据的快照 + 统计 */
  snapshot(): { state: BoardState; digested: number; posts: number; injectedChars: number };
  /** 写入被代码拒绝的记录（这是「代码守不变量」的证据） */
  rejections: string[];
}

export function newWorkbench(): Workbench {
  const state: BoardState = { notes: {}, dupGroups: [], contradictions: [], excluded: [], entries: [] };
  const rejections: string[] = [];
  let digested = 0;
  let posts = 0;
  let injectedChars = 0;

  // ── ★ 增量注入（实测修出来的）★ ──
  //
  // 第一版每轮把**整个黑板**重新注一遍。实测：总注入量 **887k 字符** ——
  // 黑板本身才几 k，但每个 agent 每轮都重注一次，几十轮 × 5 个 agent 就爆了。
  // 而成本就从这里来（board 变体跑出 1.09M–1.56M token，比 share 贵一倍）。
  //
  // 修法：黑板是**只追加**的 —— 把它改成一条事件日志，每个 agent 只收**自己没看过的**增量。
  const log: string[] = [];
  const seen = new Map<string, number>(); // selfId → 已看到第几条
  const push = (line: string) => {
    log.push(line);
  };

  /** 全量渲染（首次注入、以及快照/调试用） */
  const renderAll = (): string => {
    const L: string[] = ["【共享工作台】（所有 agent 共用；你写进去的东西别人也看得到）"];
    const noteIds = Object.keys(state.notes).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    if (noteIds.length) {
      L.push(`▸ 已记要点的材料（${noteIds.length} 份）：` + noteIds.map((id) => `${id}(${state.notes[id]})`).join("；"));
    }
    if (state.dupGroups.length) L.push("▸ 已判定的重复组：" + state.dupGroups.map((g) => g.join("≡")).join("；"));
    if (state.contradictions.length)
      L.push("▸ 已判定的矛盾对：" + state.contradictions.map((c) => `${c.pair[0]}vs${c.pair[1]}`).join("；"));
    if (state.excluded.length) L.push(`▸ 已排除（与主题无关）：${state.excluded.join("、")}`);
    if (state.entries.length) L.push(`▸ 已成文条目（${state.entries.length} 条）`);
    return L.join("\n");
  };

  /** 某个人这一轮该看到的内容：首次全量，之后只给增量 */
  const renderFor = (selfId: string): string => {
    const from = seen.get(selfId);
    if (from === undefined) {
      seen.set(selfId, log.length);
      return renderAll();
    }
    if (from >= log.length) return ""; // 没有新东西 —— 一个字都不注
    const delta = log.slice(from).join("\n");
    seen.set(selfId, log.length);
    return `【工作台更新】\n${delta}`;
  };

  // ── 校验：代码守住的不变量 ──
  // 三条都是**结构**上的，不涉及「判断对不对」：
  //   · 编号必须真实存在（挡编造）
  //   · 重复组至少两个成员（一个成员的「组」没有意义）
  //   · 矛盾必须两个不同编号
  const validate = (p: { kind: string; ids: string[] }): string | null => {
    const real = corpusIds();
    if (real.size) {
      const bad = p.ids.filter((i) => !real.has(i.toUpperCase()));
      if (bad.length) return `编号不在语料里：${bad.join("、")}（编造）`;
    }
    if (p.kind === "dup" && p.ids.length < 2) return `重复组至少要两个成员，收到 ${p.ids.length} 个`;
    if (p.kind === "contradiction" && p.ids.length !== 2) return `矛盾必须正好两个编号，收到 ${p.ids.length} 个`;
    return null;
  };

  const postTool = (_selfId: string): AgentTool =>
    defineTool({
      name: "post",
      label: "Post to Workbench",
      description:
        "把一条**结构化结论**写进共享工作台（所有 agent 都看得到）。" +
        "写完这条之后，你读过的那份原文就会被移出你的上下文 —— 所以要点必须写清楚，否则信息就丢了。",
      parameters: Type.Object({
        kind: Type.String({
          description: "note（记一份材料的要点）/ dup（判定一组重复）/ contradiction（判定一对矛盾）/ entry（一条成文条目）/ exclude（排除无关材料）",
        }),
        ids: Type.Array(Type.String({ description: "涉及的材料编号，如 [\"M12\",\"M31\"]" })),
        text: Type.String({ description: "这条结论的内容（note 时是材料要点；entry 时是事实陈述）" }),
        topic: Type.Optional(Type.String({ description: "kind=entry 时必填：属于哪个主题（T1–T5）" })),
      }),
      execute: async (_id, p) => {
        const ids = p.ids.map((s) => s.toUpperCase());
        const err = validate({ kind: p.kind, ids });
        if (err) {
          rejections.push(`${p.kind} ${ids.join("、")}：${err}`);
          return { content: [{ type: "text" as const, text: `❌ 写入被代码拒绝：${err}` }], details: { rejected: true } };
        }
        posts++;
        switch (p.kind) {
          case "note":
            for (const id of ids) {
              state.notes[id] = p.text;
              push(`· ${id} 要点：${p.text}`);
            }
            break;
          case "dup":
            // 合并进已有组（如果与某组有交集），否则新增 —— 这是**代码做保真**
            {
              const hit = state.dupGroups.filter((g) => g.some((x) => ids.includes(x)));
              if (hit.length) {
                const merged = [...new Set([...hit.flat(), ...ids])].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
                state.dupGroups = state.dupGroups.filter((g) => !hit.includes(g));
                state.dupGroups.push(merged);
                push(`· 重复组（已与已有组合并）：${merged.join("≡")}`);
              } else {
                state.dupGroups.push(ids);
                push(`· 重复组：${ids.join("≡")}`);
              }
            }
            break;
          case "contradiction":
            state.contradictions.push({ pair: [ids[0], ids[1]], note: p.text });
            push(`· 矛盾对：${ids[0]} vs ${ids[1]}（${p.text}）`);
            break;
          case "entry":
            state.entries.push({ topic: p.topic ?? "?", fact: p.text, ids });
            push(`· 成文条目[${p.topic ?? "?"}]：${p.text}（${ids.join("、")}）`);
            break;
          case "exclude":
            state.excluded = [...new Set([...state.excluded, ...ids])];
            push(`· 排除：${ids.join("、")}`);
            break;
          default:
            return { content: [{ type: "text" as const, text: `❌ 未知的 kind：${p.kind}` }], details: {} };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `✅ 已写进工作台（黑板现有 ${renderAll().length} 字符；别人下一轮就能看到）。`,
            },
          ],
          details: { kind: p.kind },
        };
      },
    });

  const attach = (agent: Agent, selfId: string): void => {
    // ── ① 每轮注入黑板（**增量**：只给这个人没看过的） ──
    agent.context.override((messages: AgentMessage[]) => {
      const block = renderFor(selfId);
      if (!block) return messages; // 没有新东西就不注 —— 这一行是成本的关键
      injectedChars += block.length;
      return [{ role: "user", content: block } as AgentMessage, ...messages];
    });

    // ── ② 读后即消化：post 之后把原文 erase 掉 ──
    //
    // ★ 定位条目为什么不能靠 preview（实测踩的坑）★
    // 第一版拿 `entries()` 的 preview 去找含 "M3" 的 toolResult 条目 —— 但
    // **preview 是那条消息的正文**（即文件内容），而文件内容不会以它自己的编号开头。
    // 所以基本匹配不上：44 份材料只消化了 3 份。
    //
    // 正确做法：在 `tool_result` **之后**取一次 `entries()`，拿**最新的** toolResult 条目 ——
    // 那个就是刚读完的那份。用「读之前记下要读谁」+「读之后拿最新条目」两步接起来。
    const pending: string[] = []; // 最近一次 read 的材料编号
    const readEntry = new Map<string, string>(); // 材料编号 → 条目 id
    const done = new Set<string>();

    agent.on("tool_call", (e) => {
      if (e.toolName !== "read") return;
      const inp = e.input as { path?: unknown; file?: unknown } | undefined;
      const path = String(inp?.path ?? inp?.file ?? "");
      const id = path.replace(/^.*[\\/]/, "").split("-")[0].toUpperCase();
      if (/^M\d+$/.test(id)) pending.push(id);
    });

    agent.on("tool_result", () => {
      const id = pending.pop();
      if (!id || done.has(id)) return;
      try {
        const latest = [...agent.context.entries()].reverse().find((en) => en.role === "toolResult");
        if (latest) readEntry.set(id, latest.id);
      } catch {
        /* 拿不到就算了 —— 最坏就是原文留着 */
      }
    });

    agent.on("tool_call", (e) => {
      if (e.toolName !== "post") return;
      const inp = e.input as { ids?: unknown } | undefined;
      const ids = Array.isArray(inp?.ids) ? inp!.ids.map((s) => String(s).toUpperCase()) : [];
      for (const id of ids) {
        if (done.has(id)) continue;
        const entryId = readEntry.get(id);
        if (!entryId) continue;
        done.add(id);
        // 原文已记进黑板 → 把它移出上下文（知识留在黑板上，原文不再占地方）
        void (async () => {
          try {
            await agent.context.erase(entryId);
            digested++;
          } catch {
            /* erase 失败不影响主流程：最坏就是原文留着（等于没消化） */
          }
        })();
      }
    });
  };

  return {
    state,
    render: renderAll,
    postTool,
    attach,
    rejections,
    snapshot: () => ({ state, digested, posts, injectedChars }),
  };
}
