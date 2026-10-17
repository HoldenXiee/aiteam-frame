// ★★★ 世界塑形（worldshape.ts）—— 用「返回值本身」当干预手段
//
// ★ 出发点（本轮重新分组 23 条成果后发现的）：
//   A 组（服从信号不服从意图）× B 组（手段在外面） = ★ **它看到的世界就是它的全部**
//   ⇒ 而 `tools.onResult` 能改的不只是"内容"，★ **是整个"感知通道"**。
//
// ★ 此前只用了「附加文本」（P8 代价、P11 计数器）—— 那是**往世界里加一条**。
//   这一轮试的是**改世界本身**：改写（replace）/ 遮蔽（mask）/ 变形（reshape）。
//
// ★★★ 一个原创的设计：「按访问次数变形」
//   同一个文件，第 1 次读给全文，第 2 次读给「你已读过，这是第 2 次」。
//   ★ 这不是"提醒它"（提示级）—— 是**那个东西本身变了**（机制级）。
//   ★ 靶子：O3 的"每轮重发已读内容"（平方成本）。若它第二次读时拿不到原文，
//     就**没法再重发** —— 从**源头**掐断平方。
//
// 档位：
//   off      不干预
//   note     ★ 附加一句"你已读过"（= P8/P11 那种，提示级对照）
//   reshape  ★★ 第 2 次起**把正文换成占位符**（机制级：东西本身变了）
//   mask     ★★★ 第 2 次起**返回错误**（"已被移出工作区"）—— 最强，但可能伤任务
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Meter } from "./measure.ts";
import type { Task } from "./tasks.ts";

const BASE = ["bash", "read", "write", "grep", "find", "ls"];

type Deps = {
  lab: { createAgent: (spec: Record<string, unknown>) => Promise<any>; cwd: string };
  MODEL: string;
};

export function worldshapeSystem(deps: Deps) {
  const { lab, MODEL } = deps;
  return {
    id: "worldshape",
    what: "★ 改「世界本身」而非「加一条」：返回值改写 / 遮蔽 / 变形",
    async run(task: Task, params: Record<string, unknown>, cwd: string, progress?: { step: string; meter?: Meter }) {
      const meter = new Meter();
      if (progress) progress.meter = meter;
      const mode = String(params.mode ?? "off");
      const n = task.corpus.length;

      const dir = join(cwd, "corpus");
      mkdirSync(dir, { recursive: true });
      for (const d of task.corpus) writeFileSync(join(dir, `${d.id}.md`), `# ${d.title}\n\n${d.text}\n`);

      if (progress) progress.step = `${mode} · ${n} 份`;

      const agent = await lab.createAgent({
        id: `WS-${mode}-${Date.now()}`,
        model: MODEL,
        role: "你按上面的要求完成任务，把结果写进指定的产物文件。",
        permissions: { only: BASE },
      });
      meter.watch(agent, { role: mode, depth: 1 });

      // ★★★ 干预：数每一份被读了几次
      const seen = new Map<string, number>();
      let replaced = 0;
      let masked = 0;
      let noted = 0;

      // ⚠ 实测坑（2026-10-17）：`toolName`/`input` 在**第 1 个参数（事件）**上，
      //   第 2 个参数是 pi 的 ExtensionContext（ui/cwd/model/...），**没有 toolName**。
      //   按 `ctx.toolName` 判断 → 永远 undefined → **静默地一次都不生效**。
      agent.tools.onResult((ev: any, _ctx: any) => {
        if (ev?.toolName !== "read") return;
        const p = String(ev.input?.path ?? ev.input?.file_path ?? "");
        const key = p.replace(/\\/g, "/").split("/").pop() ?? p;
        const times = (seen.get(key) ?? 0) + 1;
        seen.set(key, times);
        if (times === 1) return; // 第一次照常

        const body = (ev.content ?? [])
          .map((c: any) => (typeof c === "string" ? c : c?.text ?? ""))
          .join("\n");

        if (mode === "note") {
          noted++;
          return {
            content: [
              { type: "text", text: `${body}\n\n★ 注意：\`${key}\` 你上面已经读过 ${times - 1} 次了。` },
            ],
          };
        }
        if (mode === "reshape") {
          replaced++;
          return {
            content: [
              {
                type: "text",
                text:
                  `★ [\`${key}\` 的正文已收起 —— 你本轮之前已经读过它 ${times - 1} 次]\n` +
                  `★ 它的内容**已经在你的上下文里**，不必再来取一次。\n` +
                  `★ 现在请直接对**手上已有的材料**下判断。`,
              },
            ],
          };
        }
        if (mode === "mask") {
          masked++;
          return {
            content: [{ type: "text", text: `Error: \`${key}\` 本轮不可再次读取（已读 ${times - 1} 次）。` }],
            isError: true,
          };
        }
      });

      let crashed: string | undefined;
      try {
        const res = await agent.io.prompt(`${task.brief}\n\n工作目录 \`${cwd}\`，语料在 \`corpus/\`。`);
        if (res.error) crashed = `${mode} 轮失败：${res.error}`;
      } catch (e) {
        crashed = `${mode} 崩了：${(e as Error).message}`;
      }

      meter.settle();
      const p = join(cwd, task.artifact);
      const text = existsSync(p) ? readFileSync(p, "utf8") : null;

      const calls = meter.records[0]?.calls ?? [];
      const reads = calls.filter((c: string) => c === "read").length;

      // ★ 观测面：每轮 token（看平方有没有被掐断）
      const turns = agent.observe.turns.map((t: any) => t.total ?? 0);

      meter.dispose();
      return {
        meter,
        text,
        structured: {
          _ws: {
            mode,
            reads,
            // ★★ 关键读数：★ 重复读的次数（第一次之后的）
            rereads: reads - seen.size,
            distinct: seen.size,
            intervened: replaced + masked + noted,
            replaced,
            masked,
            noted,
            // ★ 平方的直接证据：每轮 token 序列
            turnTokens: turns,
            peakTurn: turns.length ? Math.max(...turns) : 0,
            lastTurn: turns.length ? turns[turns.length - 1] : 0,
          },
        },
        crashed,
      };
    },
  };
}
