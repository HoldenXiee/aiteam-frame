// 沙箱面：让**模型**能写一小段 JS，把多个 agent 调用编成一段程序。
//
// 定位（与 DESIGN.md 那句「通过代码，这种极具有逻辑的方式来使用大语言模型」对得上）：
//   普通情况下，模型一次只能选一个工具、等它回来、再选下一个 —— 串行、逐个。
//   有了这个工具，模型可以写：
//     const agents = await Promise.all(ids.map(i => tools.spawn_agent({ role: "worker" })));
//     const outs = await Promise.all(agents.map(a => tools.prompt_agent({ id: a.id, text: "读材料" })));
//     return outs.filter(o => o.text.includes("问题"));
//   —— 并发的、带判断的、带过滤的。**编排逻辑从「模型一轮一轮选」变成「一段代码」。**
//
// 与 pi 的 codemode 的区别：pi 的 codemode 把**它自己的工具**（read/bash/...）暴露给脚本；
// 这里把 **aiteam 的面**暴露给脚本 —— 也就是模型能通过脚本去动 agent 本身。
// 这正是 examples/11-redline.ts 那条「可被推翻的假设」的正面实现：v1 里「agent 不能设计 agent」
// 焊在库上，v2 降成使用者代码，这里把它做成一个**可声明的能力**。
//
// 边界由**设计者**声明（约定 `capabilities` 白名单），库不预设策略：
//   createSandbox({ capabilities: ["spawn", "prompt"] })   ← 只给这俩，其余一律不可见
//   createSandbox({ capabilities: ["*"] })                  ← 全给（设计者自己承担）
// 沙箱里看不到的能力**连存在都看不见**：`ALL_TOOLS` / `describeTool` 里也没有它 —— 这是刻意的，
// 「看得见但调不动」会让模型反复试错并浪费轮次。
import {
  InlineCodemodeSandbox,
  loadQuickJSWasm,
  type CodemodeResult,
  type CodemodeTool,
} from "@earendil-works/pi-codemode";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Lab } from "../agent/lab.ts";
import type { Agent, AgentSpec, AgentTool, SandboxCapability, SandboxOptions } from "../agent/types.ts";

export type { SandboxCapability, SandboxOptions } from "../agent/types.ts";

/** 能力 → 它需要哪些依赖（用于「声明了但库没给」时报错） */
const ALL_CAPABILITIES: SandboxCapability[] = [
  "spawn", "prompt", "queue", "interrupt", "wait_idle",
  "read_context", "read_usage", "list_agents",
  "tools_add", "tools_remove", "perm_only", "dispose",
];

/** 沙箱工具名（脚本里 `tools.<name>()`）。与能力同名，少一层翻译 */
function toolFor(
  name: SandboxCapability,
  description: string,
  inputSchema: Record<string, unknown>,
  fn: (args: Record<string, unknown>) => Promise<unknown> | unknown,
): CodemodeTool {
  return { name, description, inputSchema, execute: (args) => fn((args ?? {}) as Record<string, unknown>) };
}

/**
 * 造一个「模型写代码编排 agent」的工具。
 *
 * 返回的是**一个普通 AgentTool** —— 用 `agent.tools.add(...)` 加进去就行，不新增机制。
 * 这是设计上刻意的：沙箱面不是第八个面，它是**工具面里的一种工具**。
 */
export function createSandbox(deps: { lab: Pick<Lab, "createAgent"> } & SandboxOptions): {
  tool: AgentTool;
  capabilities: SandboxCapability[];
  children(): { id: string; status: string }[];
  close(): void;
} {
  const { agent, timeoutMs = 300_000, maxSpawn = 8 } = deps;
  const wanted: SandboxCapability[] = (
    (deps.capabilities as readonly string[]).includes("*")
      ? [...ALL_CAPABILITIES]
      : [...(deps.capabilities as SandboxCapability[])]
  );

  // ── 沙箱里活着的子 agent（限一层：这些子 agent 自己没有再拿到沙箱）──
  const spawned = new Map<string, Agent>();
  let sandbox: InlineCodemodeSandbox | undefined;
  let wasm: Awaited<ReturnType<typeof loadQuickJSWasm>> | undefined;

  const tools: CodemodeTool[] = [];
  const have = (c: SandboxCapability) => wanted.includes(c);

  // ── 起 agent ──
  if (have("spawn")) {
    tools.push(
      toolFor(
        "spawn",
        `起一个子 agent（最多 ${maxSpawn} 个）。返回 { id }。` +
          "**子 agent 没有沙箱能力**，它只能像普通 agent 那样一个一个调工具。",
        { type: "object", properties: { role: { type: "string" }, model: { type: "string" } } },
        async (a) => {
          if (spawned.size >= maxSpawn) throw new Error(`已经起了 ${maxSpawn} 个子 agent，到上限了`);
          // 限一层：模板里**不**带沙箱工具 —— 子 agent 拿到的只是普通 agent
          const spec: AgentSpec = { ...(deps.template ?? {}), role: String(a.role ?? deps.template?.role ?? "worker") };
          if (a.model) spec.model = String(a.model);
          const child = await deps.lab.createAgent(spec);
          spawned.set(child.id, child);
          return { id: child.id };
        },
      ),
    );
  }

  // ── 让某个 agent 干活 ──
  const resolve = (a: Record<string, unknown>): Agent => {
    const id = String(a.id ?? "");
    const target = spawned.get(id) ?? (id === agent.id ? agent : undefined);
    if (!target) throw new Error(`没有这个 agent：${id}（活着的见 list_agents）`);
    return target;
  };

  if (have("prompt")) {
    tools.push(
      toolFor(
        "prompt",
        "给某个 agent 发一句话，**等它做完**再返回它的回答。可以 Promise.all 并发发多个。",
        { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] },
        async (a) => {
          const r = await resolve(a).io.prompt(String(a.text ?? ""));
          return { text: r.text ?? "", error: r.error ?? null };
        },
      ),
    );
  }

  if (have("queue")) {
    tools.push(
      toolFor("queue", "排队投递：不打断它正在做的事，等它空了再发。不返回回答。", 
        { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] },
        (a) => { resolve(a).io.queue(String(a.text ?? "")); return { queued: true }; }),
    );
  }

  if (have("interrupt")) {
    tools.push(
      toolFor("interrupt", "打断某个 agent 正在做的事（它手上的产出可能作废；不会给它新输入）。", 
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        async (a) => { await resolve(a).io.abort(); return { aborted: true }; }),
    );
  }

  if (have("wait_idle")) {
    tools.push(
      toolFor("wait_idle", "等某个 agent 空下来。", 
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        async (a) => { await resolve(a).io.waitIdle(); return { idle: true }; }),
    );
  }

  // ── 读 ──
  if (have("read_context")) {
    tools.push(
      toolFor("read_context", "读某个 agent 的上下文历史（统计摘要，不是全文）。", 
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        (a) => {
          const h = resolve(a).context.history;
          return { turns: h.length, preview: JSON.stringify(h.slice(-2)).slice(0, 400) };
        }),
    );
  }

  if (have("read_usage")) {
    tools.push(
      toolFor("read_usage", "读某个 agent 的累计用量。", 
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        (a) => resolve(a).usage),
    );
  }

  if (have("list_agents")) {
    tools.push(
      toolFor("list_agents", "列出本沙箱起过的子 agent 的 id 与角色。", { type: "object", properties: {} },
        () => [...spawned.entries()].map(([id, c]) => ({ id, status: c.status }))),
    );
  }

  // ── 改声明面（都要空闲；沙箱里出错就是抛给脚本，脚本可以 catch）──
  if (have("tools_add")) {
    tools.push(
      toolFor("tools_add", "给某个 agent 加一个工具。**加工具需要那个 agent 空闲。** 这里只能加不存在的简单工具。",
        { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" } }, required: ["id", "name", "description"] },
        async (a) => {
          const name = String(a.name);
          const target = resolve(a);
          await target.tools.add(
            defineTool({
              name,
              label: name,
              description: String(a.description),
              parameters: Type.Object({}),
              execute: async () => ({ content: [{ type: "text" as const, text: "（这是沙箱运行期加进来的占位工具）" }], details: {} }),
            }),
          );
          return { added: name };
        }),
    );
  }

  if (have("tools_remove")) {
    tools.push(
      toolFor("tools_remove", "从某个 agent 摘掉一个工具（需要它空闲）。", 
        { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] },
        async (a) => { await resolve(a).tools.remove(String(a.name)); return { removed: String(a.name) }; }),
    );
  }

  if (have("perm_only")) {
    tools.push(
      toolFor("perm_only", "把某个 agent 能用的工具收窄成这几个（需要它空闲）。", 
        { type: "object", properties: { id: { type: "string" }, names: { type: "array", items: { type: "string" } } }, required: ["id", "names"] },
        async (a) => { await resolve(a).permissions.only((a.names as string[]) ?? []); return { only: a.names }; }),
    );
  }

  if (have("dispose")) {
    tools.push(
      toolFor("dispose", "回收一个子 agent。**回收后它的 id 失效**，请先把要留的产出取回来。", 
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        (a) => {
          const id = String(a.id);
          const target = spawned.get(id);
          if (!target) throw new Error(`只能回收自己起的子 agent：${id}`);
          target.dispose();
          spawned.delete(id);
          return { disposed: id };
        }),
    );
  }

  // ── 工具本身 ──
  const tool = defineTool({
    name: "codemode",
    label: "Codemode",
    description:
      "写一小段 JavaScript 来编排 agent 的调用。脚本在沙箱里跑（没有文件系统、网络、进程）。\n" +
      "脚本是 async 函数体，可以用顶层 await 与 return。可用的东西：\n" +
      tools.map((t) => `  tools.${t.name}(args) —— ${t.description}`).join("\n") +
      "\n只有脚本的 return 值会回到你面前，所以可以跑很多次调用、自己过滤，只把结论带回来。\n" +
      "**并发**：`await Promise.all([...])` 真的会并行跑，比一个一个调快得多。",
    parameters: Type.Object({ script: Type.String({ description: "要执行的 JavaScript 源码（不是 JSON、不要代码块）" }) }),
    execute: async (_id, params) => {
      // 惰性建沙箱：只有真的用了才付 wasm 加载的代价
      if (!sandbox) {
        wasm = await loadQuickJSWasm();
        sandbox = new InlineCodemodeSandbox({ tools, wasm, timeoutMs });
      }
      const result: CodemodeResult = await sandbox.execute(String(params.script));
      return {
        content: [{ type: "text" as const, text: renderResult(result) }],
        details: { ok: result.ok, calls: result.calls },
      };
    },
  });

  return {
    tool: tool as AgentTool,
    capabilities: wanted,
    children: () => [...spawned.entries()].map(([id, c]) => ({ id, status: c.status })),
    close() {
      for (const c of spawned.values()) {
        try { c.dispose(); } catch { /* 已经没了就算了 */ }
      }
      spawned.clear();
      sandbox?.close();
      sandbox = undefined;
    },
  };
}

/** 把沙箱结果转成给模型看的文本：**只回结论与轨迹**，中间过程不进上下文 */
function renderResult(r: CodemodeResult): string {
  const lines: string[] = [];
  if (r.ok) {
    lines.push("脚本跑完了。");
    if (r.value !== undefined) lines.push(`返回：${typeof r.value === "string" ? r.value : JSON.stringify(r.value)}`);
    for (const item of r.output) {
      if (item.type === "text") lines.push(item.console ? `[console] ${item.text}` : item.text);
    }
  } else {
    lines.push(`脚本失败：${r.error?.kind ?? "未知"} —— ${r.error?.message ?? ""}`);
    for (const item of r.output) if (item.type === "text") lines.push(item.text);
  }
  if (r.calls.length) {
    lines.push(`调用轨迹（${r.calls.length} 次）：`);
    for (const c of r.calls) lines.push(`  ${c.name} ${c.status} ${Math.round(c.durationMs)}ms`);
  }
  return lines.join("\n");
}