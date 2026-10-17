// 实验 I：交接面到底该传什么 —— 由 N1 驱动（跨 agent 重复读 28.3%）
//
// ★ 现象（N1，n=8036 read / 86 run）
//   上游读过的原文，**下游全部重读一遍**。28.3% 的 read 落在「被 ≥2 个角色读过」的文件上，
//   而且方向**恒定沿流水线向后**（S1→S2 598 次、S1→S3 309 次）。
//   ⇒ **委派省下了"注意力"，但没省下"读入"。**
//
// ★ 与 P5 的区别（容易混）
//   P5 治的是「**不知道有哪些文件**」（→ 给 ls / 给清单）
//   本实验治的是「**上游已经知道的东西，怎么传下去**」（→ 交接物的设计）
//   —— 这是 P8「往返回值里放东西」在**交接面**上的推广。
//
// ★ 三档（自变量 = 交接物里装什么）
//   conclusion  只传结论（现状 / 对照）
//   readlist    结论 + **上游读过的文件清单**（带每份的一句话要点）
//   digest      结论 + 清单 + **上游从每份里提炼的要点**（要求上游显式产出）
//
// ★ 观测量（核心）
//   ★ 跨 agent 重复读率（N1 的口径）—— 同一个文件被 ≥2 个 agent 读的次数 / 总 read
//   总 token、调用数、任务成败
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Meter } from "./measure.ts";
import type { Task } from "./tasks.ts";

/** 扁平化文件名（与 scan.ts 的 fileOf 同口径） */
function fileOf(id: string): string {
  return id.replace(/[\/:*?"<>|]/g, "_") + ".md";
}
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

type Deps = {
  lab: { createAgent: (spec: Record<string, unknown>) => Promise<any>; cwd: string };
  MODEL: string;
  READ_WRITE: string[];
};

export function carrySystem(deps: Deps) {
  const { lab, MODEL, READ_WRITE } = deps;
  return {
    id: "carry",
    what: "I 交接物：conclusion / readlist / digest —— 上游知道的东西怎么传下去",
    async run(task: Task, params: Record<string, unknown>, cwd: string, progress?: { step: string; meter?: Meter }) {
      const meter = new Meter();
      if (progress) progress.meter = meter;
      if (progress) progress.step = "开始（carry）";
      const mode = String(params.carry ?? "conclusion");

      // ── 阶段定义 ──
      // ★ readlist 档要求 S1 **额外**写一份「读过哪些、每份讲了什么」的清单
      const s1Task =
        mode === "conclusion"
          ? "列出 corpus/ 里每份材料的编号与它讲的一句话大意，写进 draft/survey.md。"
          : "列出 corpus/ 里每份材料的编号、你**实际读过**的文件名、以及每份讲的一句话大意。" +
            "写进 draft/survey.md（每行形如：`M1 | M1.md | 大意…`）。";

      const stagesDef = [
        {
          id: "S1-摸底",
          role: "你负责摸底：看清 corpus/ 里有哪些材料、它们大致在说什么。不要下结论，只写你看到的。",
          task: s1Task,
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
      ];

      /** 读上游产物的原文，作为「交接物」的原料 */
      const readDraft = (name: string): string => {
        const p = join(cwd, name);
        return existsSync(p) ? readFileSync(p, "utf8") : "";
      };

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
        if (progress) progress.step = `prompt 中（${st.id}）`;
        meter.watch(agent, { role: st.id, depth: n });

        // ── ★ 交接物：按 mode 组装 ──
        let extra = "";
        if (n > 1 && mode !== "conclusion") {
          const survey = readDraft("draft/survey.md");
          const corpusList = task.corpus.map((d) => fileOf(d.id)).join("、");
          if (mode === "readlist") {
            extra +=
              `\n\n📋 上游已经读过这些文件（${task.corpus.length} 份）：${corpusList}` +
              `\n上游的调查记录（draft/survey.md）如下，其中已包含每一份的要点：` +
              `\n----\n${survey.slice(0, 3000)}\n----` +
              `\n⚠ 里面的内容已经在上面了 —— **不要为了同一件事再读一遍原文**，除非你怀疑上游记错了。`;
          } else if (mode === "digest") {
            extra +=
              `\n\n📋 上游已经读过这些文件（${task.corpus.length} 份）：${corpusList}` +
              `\n上游从每一份里提炼的要点：` +
              `\n----\n${survey.slice(0, 4000)}\n----` +
              `\n⚠ **原文你已经拿到了（就是上面这份要点）** —— 你的任务是**在要点上做判断**，` +
              `不是重新读一遍原文。只有在要点里**找不到依据**时，才去 read 那一份。`;
          }
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
