// 线 2 · F-5 + F-6 —— 判断强制落盘
//
// ★ 现象驱动（A1 / override 实验）
//   上游只写「大意」→ 下游拿不到判断 → 抽掉原文就 0/3（不产出）
//   而上游**自己做了判断**的那一档（Fp-info conclusion）→ 下游读 1 次，8/8 全对
//   ⇒ 真机制不是「原文 vs 摘要」，是「上游有没有把判断落成数据」
//
// ★ 分析
//   现在这个「判断」靠**提示词求它写**（「请写进 groups.json」）—— 它**可以选择不写**。
//   该治的层：`permissions.gate`（拦下「不写就收尾」）+ `tools.add`（给它一个正当的提交渠道）
//
// ★ 自变量（三档）
//   ask      仅提示（对照：就是现状）
//   gate     拦住 write —— 没提交判断就不许落盘
//   gate+tool 拦住 write + 给它一个带 schema 的真工具 `submit_groups`
//
// ★ 观测量
//   产物存在率 / 判断提交率 / 下游读语料次数 / 过度合并数 / token
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Meter } from "./measure.ts";
import type { Task } from "./tasks.ts";

type Deps = {
  lab: { createAgent: (spec: Record<string, unknown>) => Promise<any>; cwd: string };
  MODEL: string;
  READ_WRITE: string[];
};

export function commitSystem(deps: Deps) {
  const { lab, MODEL, READ_WRITE } = deps;
  return {
    id: "commit",
    what: "F-5/F-6 判断强制落盘 —— 拦住收尾，逼它把判断交成数据",
    async run(task: Task, params: Record<string, unknown>, cwd: string, progress?: { step: string; meter?: Meter }) {
      const meter = new Meter();
      if (progress) progress.meter = meter;
      const mode = String(params.mode ?? "ask"); // ask | gate | gate_tool

      const stages = [
        {
          id: "S1-去重",
          role: "你负责去重：找出哪些材料在讲同一件事。**必须先把判断交出来。**",
        },
        {
          id: "S2-落盘",
          role: `你负责落盘：读上游交出的判断，写成 ${task.artifact}。`,
        },
      ];

      let crashed: string | undefined;
      let committed = 0;
      let blockedCount = 0;
      for (let i = 0; i < stages.length; i++) {
        const st = stages[i];
        const n = i + 1;
        const agent = await lab.createAgent({
          id: `${st.id}-${Date.now()}`,
          model: MODEL,
          role: st.role,
          permissions: { only: READ_WRITE },
        });
        if (progress) progress.step = `${mode} · ${st.id}`;
        meter.watch(agent, { role: st.id, depth: n });

        const commitPath = join(cwd, `draft/judgment-${n}.json`);

        // ── ★ F-6：给它一个带 schema 的真工具（不是靠提示求它写） ──
        if (mode === "gate_tool") {
          await agent.tools.add({
            name: "submit_groups",
            label: "提交分组判断",
            description: "提交你的去重判断。**在做任何落盘之前必须先调用这个。**",
            parameters: {
              type: "object",
              properties: {
                duplicates: {
                  type: "array",
                  description: "重复组列表，每组是材料编号的数组（如 [[\"M1\",\"M2\"]]）",
                  items: { type: "array", items: { type: "string" } },
                },
              },
              required: ["duplicates"],
            },
            execute: async (_id: string, p: { duplicates: string[][] }) => {
              committed++;
              const { writeFileSync, mkdirSync } = await import("node:fs");
              mkdirSync(join(cwd, "draft"), { recursive: true });
              writeFileSync(commitPath, JSON.stringify({ duplicates: p.duplicates }));
              return { content: [{ type: "text", text: `已收到你的判断（${p.duplicates.length} 组），现在可以落盘了。` }] };
            },
          });
        }

        // ── ★ F-5：拦住「收尾动作」──
        if (mode === "gate" || mode === "gate_tool") {
          agent.permissions.gate(async (call: { name: string }) => {
            if (call.name !== "write" && call.name !== "edit") return undefined;
            // 判断交了没有？
            if (existsSync(commitPath)) return undefined;
            blockedCount++;
            return {
              block: true,
              reason:
                mode === "gate_tool"
                  ? "在你落盘之前，**先用 `submit_groups` 提交你的分组判断**（系统需要它做交接）。"
                  : "在你落盘之前，**先把分组判断写到 `draft/judgment-1.json`**（形如 {\"duplicates\":[[\"M1\",\"M2\"]]}）。",
            };
          });
        }

        try {
          const prompt =
            mode === "gate_tool"
              ? `${st.role}\n\n任务：corpus/ 里有 ${task.corpus.length} 份材料，找出所有重复组。`
              : `${st.role}\n\n任务：corpus/ 里有 ${task.corpus.length} 份材料，找出所有重复组。` +
                (mode === "gate" ? `\n**在写 ${task.artifact} 之前，先把判断写到 draft/judgment-${n}.json**（形如 {"duplicates":[["M1","M2"]]}）。` : "");
          const res = await agent.io.prompt(prompt);
          if (res.error) crashed = `${st.id} 失败：${res.error}`;
        } catch (e) {
          crashed = `${st.id} 崩了：${(e as Error).message}`;
        }
        if (crashed) break;

        // S2 拿上游的判断（把它放进任务里 —— 与 A1 的「完整交接」同构）
        if (n === 1 && existsSync(commitPath)) {
          const jud = readFileSync(commitPath, "utf8");
          stages[1].role += `\n\n上游已经交出了判断：\n----\n${jud}\n----\n直接用它落盘即可。`;
        }
      }

      meter.settle();
      const p = join(cwd, task.artifact);
      const text = existsSync(p) ? readFileSync(p, "utf8") : null;
      meter.dispose();
      return {
        meter,
        text,
        structured: { _commit: { mode, committed, blockedCount } },
        crashed,
      };
    },
  };
}
