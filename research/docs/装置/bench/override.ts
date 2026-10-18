// A1 · 用 `context.override` 而不是提示 —— 把下游那一轮真正发出去的原文换掉
//
// ★ 为什么换机制（研究员指出）
//   实验 I（P9）是**提示它"别重读"** —— 实测只有 1/3 轮听（它重读了 26 份）。
//   ⇒ 结论弱：分不清"它不听劝"还是"这机制不行"。
//
//   `context.override` 改的是「**这一轮真正发给模型的内容**」——
//   ★ 它不是"被劝"，是**收到的东西里原文已经不在了**。
//
// ★ 三档（自变量 = 用什么机制去"不要它重读"）
//   prompt    仅提示（实验 I 的 readlist 档，对照）
//   override  ★ 在那一轮发给模型的消息里，把语料的 toolResult 内容**替换成一行占位**
//   both      提示 + override
//
// ★ 观测量
//   ★ 下游(S2/S3)读语料的次数 —— 这是核心
//   跨 agent 重复读、token、通过率、过度合并
//
// ⚠ 关键设计：**只对下游**（n>1）生效，且**只替换"语料原文"的返回**
//   （不是替换所有返回 —— 否则它连上游产物都看不见）
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Meter } from "./measure.ts";
import type { Task } from "./tasks.ts";

type Deps = {
  lab: { createAgent: (spec: Record<string, unknown>) => Promise<any>; cwd: string };
  MODEL: string;
  READ_WRITE: string[];
};

/** 从一条消息里抽纯文本 */
function textOf(m: { content?: unknown }): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: { text?: string }) => b.text ?? "").join("");
  return "";
}

export function overrideSystem(deps: Deps) {
  const { lab, MODEL, READ_WRITE } = deps;
  return {
    id: "override",
    what: "A1 · 用 context.override 把下游那轮发出去的语料原文换掉（而不是提示它别读）",
    async run(task: Task, params: Record<string, unknown>, cwd: string, progress?: { step: string; meter?: Meter }) {
      const meter = new Meter();
      if (progress) progress.meter = meter;
      if (progress) progress.step = "开始（override）";
      const mode = String(params.mode ?? "prompt"); // prompt | override | both

      const stagesDef = [
        {
          id: "S1-摸底",
          role: "你负责摸底：看清 corpus/ 里有哪些材料、它们大致在说什么。不要下结论，只写你看到的。",
          task: "列出 corpus/ 里每份材料的编号与它讲的一句话大意，写进 draft/survey.md。",
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

      let crashed: string | undefined;
      let replaced = 0;
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

        // ── ★ A1 的核心：用 context.override 改这一轮发出去的内容 ──
        // 只对下游（n>1）生效。把**语料原文的 toolResult** 换成一行占位，
        // 而上游产物（draft/*）**保持原样** —— 它需要的判断依据还在。
        if (mode === "override" || mode === "both") {
          if (n > 1) {
            // ⚠ 实测（_inspect）修正：toolResult 的内容里**只有正文，不含路径**。
            //   所以「消息里有 corpus/ 路径」是错的判据 —— 生效次数实测为 0。
            //   ★ 正确判据：`m.toolName === "read"`，且内容不是上游产物。
            agent.context.override((messages: { role?: string; toolName?: string; content?: unknown }[]) =>
              messages.map((m) => {
                if (m.role !== "toolResult" || m.toolName !== "read") return m;
                const t = textOf(m);
                // 上游产物要留（它需要判断依据）—— 语料原文才省
                const looksLikeDraft = /duplicates|survey|^\s*\{/.test(t.slice(0, 200));
                if (looksLikeDraft) return m;
                replaced++;
                return { ...m, content: "[语料原文已被系统省略：其要点见上游的 draft/survey.md]" };
              }),
            );
          }
        }

        // 提示档（实验 I 的做法，作对照）
        let extra = "";
        if ((mode === "prompt" || mode === "both") && n > 1) {
          const corpusList = task.corpus.map((d) => d.id.replace(/[\\/:*?"<>|]/g, "_") + ".md").join("、");
          const survey = existsSync(join(cwd, "draft/survey.md")) ? readFileSync(join(cwd, "draft/survey.md"), "utf8") : "";
          extra =
            `\n\n📋 上游已经读过这些文件（${task.corpus.length} 份）：${corpusList}` +
            `\n上游的调查记录：\n----\n${survey.slice(0, 3000)}\n----` +
            `\n⚠ 里面的内容已经在上面了 —— **不要为了同一件事再读一遍原文**。`;
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
      const p = join(cwd, task.artifact);
      const text = existsSync(p) ? readFileSync(p, "utf8") : null;
      meter.dispose();
      return { meter, text, structured: { _override: { mode, replaced } }, crashed };
    },
  };
}
