// ★ 意图落地系统（T-H / 族 B）—— DESIGN「让人的意图/想法落地」的正面测试
//
// ★★ 设计核心：**人给的是「意图」，不是「题目」**
//   此前所有任务，brief 都是我写好的明确题目 —— 那等于**我把人的思考替人做完了**。
//   这条族里人只给**一句话的模糊意图**，中间的判断全归 agent。
//
// ★ 自变量（★ **人在哪里介入、介入多少**）
//   intent       ★ 只给那句原话（最像真实：人就说一句）
//   intent+ask   ★ 原话 + 允许它**回来问人**（把"问"也当一条通道）
//   spec         人把要求列全（对照：人替它把判断做完了）
//
// ★ 因变量
//   判据五项（找出重复 / 找出矛盾 / 溯源 / 分开两类 / 简短）
//   ★ 关键读数：**溯源率**（每条结论带不带得回出处）—— 真实调研的标准
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Meter } from "./measure.ts";
import { buildIntentTask, judgeIntent } from "./tasks-intent.ts";
import type { Task } from "./tasks.ts";

const TOOLS = ["bash", "read", "write", "grep", "find", "ls"];

type Deps = {
  lab: { createAgent: (spec: Record<string, unknown>) => Promise<any>; cwd: string };
  MODEL: string;
};

export function intentSystem(deps: Deps) {
  const { lab, MODEL } = deps;
  return {
    id: "intent",
    what: "T-H · 模糊意图 → 可核对产物（人的意图落地）",
    async run(task: Task, params: Record<string, unknown>, cwd: string, progress?: { step: string; meter?: Meter }) {
      const meter = new Meter();
      if (progress) progress.meter = meter;
      const mode = String(params.mode ?? "intent");
      const n = task.corpus.length;

      // 铺笔记
      const dir = join(cwd, "notes");
      mkdirSync(dir, { recursive: true });
      for (const d of task.corpus) writeFileSync(join(dir, `${d.id}.md`), `# ${d.title}\n\n${d.text}\n`);

      // ★ 三档的差别
      let extra = "";
      if (mode === "intent") {
        extra = ""; // 就那一句原话
      } else if (mode === "intent+ask") {
        extra =
          "\n\n★ **如果你需要更多信息才能开工，可以先把问题写进 `ask.md` 问我**（我会回答），再动手。";
      } else {
        extra =
          "\n\n★ 具体要求（研究员列全了）：\n" +
          "1. 逐份读完 notes/ 下的每一份笔记。\n" +
          "2. 把说法**重复**的（N1/N2/N10 这类讲同一件事的）归成组。\n" +
          "3. 把说法**互相矛盾**的（N3/N4、N7/N8 这类）成对列出。\n" +
          "4. 每条结论后面用括号标出处，如 `(N1, N2)`。\n" +
          "5. 全文不超过 3000 字。\n";
      }

      if (progress) progress.step = `${mode} · ${n} 份笔记`;
      const agent = await lab.createAgent({
        id: `IN-${mode}-${Date.now()}`,
        model: MODEL,
        role:
          "你是研究员的助手。他会给你**一句话**，你要把它变成一份**他能直接用的**产物。\n" +
          "★ 他说得不全的地方，**你自己判断** —— 但要保证他能**核对回原文**。",
        permissions: { only: TOOLS },
      });
      meter.watch(agent, { role: mode, depth: 1 });

      let crashed: string | undefined;
      try {
        const res = await agent.io.prompt(`${task.brief}\n\n你的工作目录是 \`${cwd}\`。${extra}`);
        if (res.error) crashed = `${mode} 轮失败：${res.error}`;
      } catch (e) {
        crashed = `${mode} 崩了：${(e as Error).message}`;
      }

      meter.settle();
      const p = join(cwd, task.artifact);
      const text = existsSync(p) ? readFileSync(p, "utf8") : null;

      // 工具分布
      const calls = meter.records[0]?.calls ?? [];
      const dist: Record<string, number> = {};
      for (const t of calls) dist[t] = (dist[t] ?? 0) + 1;

      // ★ 它有没有回来问人（intent+ask 档的关键行为）
      const asked = existsSync(join(cwd, "ask.md")) ? readFileSync(join(cwd, "ask.md"), "utf8") : null;

      // 判据
      const hidden = task.hidden as { dupGroups: string[][]; conflicts: string[][] };
      const judgement = judgeIntent(text, hidden.dupGroups, hidden.conflicts);

      meter.dispose();
      return {
        meter,
        text,
        structured: {
          _intent: {
            mode,
            toolDist: dist,
            // ★ 关键读数
            traceRate: judgement.readings.traceRate,
            paragraphs: judgement.readings.paragraphs,
            dupFound: judgement.readings.dupFound,
            conflictFound: judgement.readings.conflictFound,
            chars: judgement.readings.chars,
            askedHuman: asked !== null,
            askLength: asked?.length ?? 0,
          },
        },
        crashed,
      };
    },
  };
}
