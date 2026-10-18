// ★★★ 世界塑形 · 管线版（wsline.ts）
//
// ★ 为什么要这个：第一版 ws 拿单 agent 当靶子 —— **它根本不重读**（reads=11, 重读=0）。
//   O3 的平方发生在**管线里**：S2/S3 为了核实上游结论，会去重读 S1 读过的原文，
//   而且此后**每轮都把已读过的原文再发一遍**。
//
// ★ 干预点选在**下游 agent 重复读上游已读过的那一份**时 —— 这才是平方的发源地。
//
// 档位（★ 从"加一条"到"改世界"）：
//   off       不干预（基线：平方发生）
//   note      ★ 附加一句"上游读过这份了"（提示级）
//   reshape   ★★ 把正文换成「上游已处理，结论见交接」+ 上游结论（★ 世界本身变了）
//   mask      ★★★ 直接报错（"这份不归你管"）—— 逼它只用交接物
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Meter } from "./measure.ts";
import type { Task } from "./tasks.ts";

const BASE = ["bash", "read", "write", "grep", "find", "ls"];

type Deps = {
  lab: { createAgent: (spec: Record<string, unknown>) => Promise<any>; cwd: string };
  MODEL: string;
};

export function wslineSystem(deps: Deps) {
  const { lab, MODEL } = deps;
  return {
    id: "wsline",
    what: "★ 世界塑形（管线版）：在「下游重读」这个平方发源地下手",
    async run(task: Task, params: Record<string, unknown>, cwd: string, progress?: { step: string; meter?: Meter }) {
      const meter = new Meter();
      if (progress) progress.meter = meter;
      const mode = String(params.mode ?? "off");
      const stages = Number(params.stages ?? 3);

      const dir = join(cwd, "corpus");
      mkdirSync(dir, { recursive: true });
      for (const d of task.corpus) writeFileSync(join(dir, `${d.id}.md`), `# ${d.title}\n\n${d.text}\n`);

      // ★ 全局：哪些份"已经被上游读过"。跨 agent 共享（这正是"世界"的含义）
      const readBy = new Map<string, number>(); // 文件名 → 阶段号
      let seenAny = new Set<string>();

      const stageNames = ["S1-摸底", "S2-去重", "S3-成文"];
      let upstream = "";
      let lastAgent: any = null;
      let crashed: string | undefined;

      for (let s = 1; s <= stages; s++) {
        if (progress) progress.step = `${mode} · ${stageNames[s - 1]}`;

        const agent = await lab.createAgent({
          id: `WSL-${mode}-S${s}-${Date.now()}`,
          model: MODEL,
          role:
            s === 1
              ? "你负责摸底：看清 corpus/ 里有哪些材料、大致在说什么。不要下结论，只写你看到的。"
              : s === 2
                ? "你负责找出「讲同一件事」的材料分组。**要给出结论**（哪几份是一组），并写清判据。"
                : "你负责成文：把分组结论写成报告。产物写进 " + task.artifact + "。",
          permissions: { only: BASE },
        });
        meter.watch(agent, { role: stageNames[s - 1], depth: 1 });
        lastAgent = agent;

        // ★★★ 干预：下游读一份"上游已经读过"的材料时，改世界
        let hit = 0;
        agent.tools.onResult((ev: any, _ctx: any) => {
          if (ev?.toolName !== "read") return;
          const key = String(ev.input?.path ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
          if (!seenAny.has(key)) {
            seenAny.add(key);
            readBy.set(key, s);
            return; // 第一次读：照常
          }
          // ★ 是"上游已经读过的那一份" → 干预
          hit++;
          const body = (ev.content ?? []).map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
          if (mode === "note") {
            return { content: [{ type: "text", text: `${body}\n\n★ 注意：这份材料在上游（S${readBy.get(key)}）已经读过了。` }] };
          }
          if (mode === "reshape") {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `★ [\`${key}\` 已被上游（S${readBy.get(key)}）处理 —— 正文不再重复下发]\n` +
                    `★ 上游给出的交接物如下，请**依据它**做判断；若真的需要原文另行说明。\n\n` +
                    `────── S${s - 1} 的交接物 ──────\n${upstream.slice(0, 4000)}\n─────────────────`,
                },
              ],
            };
          }
          if (mode === "mask") {
            return { content: [{ type: "text", text: `Error: \`${key}\` 已在 S${readBy.get(key)} 处理完毕，本阶段不重复下发。` }], isError: true };
          }
        });

        const handed = upstream ? `\n\n────── 上一阶段的交接物 ──────\n${upstream}\n─────────────────\n` : "";
        try {
          const res = await agent.io.prompt(
            `corpus/ 里有 ${task.corpus.length} 份材料。\n${handed}\n` +
              (s === 1 ? "请先看清有哪些材料。" : s === 2 ? "请找出讲同一件事的分组。" : task.brief),
          );
          if (res.error) crashed = `S${s} 失败：${res.error}`;
        } catch (e) {
          crashed = `S${s} 崩了：${(e as Error).message}`;
        }

        // 交接物 = 它的最后一条 assistant 文本
        const wire = agent.observe.lastWire ?? [];
        for (let i = wire.length - 1; i >= 0; i--) {
          const m = wire[i] as any;
          if (m?.role === "assistant") {
            const t = (m.content ?? []).map((c: any) => c?.text ?? "").join("\n");
            if (t.trim()) {
              upstream = t;
              break;
            }
          }
        }
        meter.settle();
        meter.noteInjection(`S${s}`, `世界塑形=${mode}，命中 ${hit} 次`, `${mode}:${hit}`);
      }

      const p = join(cwd, task.artifact);
      const text = existsSync(p) ? readFileSync(p, "utf8") : null;
      const turns = lastAgent?.observe?.turns?.map((t: any) => t.total ?? 0) ?? [];
      meter.dispose();

      return {
        meter,
        text,
        structured: {
          _wsl: {
            mode,
            totalReads: meter.records.reduce((a, r) => a + (r.calls ?? []).filter((c: string) => c === "read").length, 0),
            distinctFiles: seenAny.size,
            // ★★ 关键：下游（S≥2）读了几次
            downstreamReads: (meter.records.slice(1) ?? []).reduce(
              (a: number, r: any) => a + (r.calls ?? []).filter((c: string) => c === "read").length,
              0,
            ),
            lastTurnTokens: turns.length ? turns[turns.length - 1] : 0,
            peakTurnTokens: turns.length ? Math.max(...turns) : 0,
          },
        },
        crashed,
      };
    },
  };
}
