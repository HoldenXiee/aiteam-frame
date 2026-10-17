// 线 1 · F-1 自省账本 —— 让 agent「看见自己做过什么」
//
// ★ 现象驱动（第六版规划）
//   O3 成本盲区：质量全对的 177 run，token 差 316 倍 —— 「正确」判据下成本是自由变量
//   P8：往返回值放「调用数 + 阈值」→ token 降到 1/5，调用砍半
//   A1：把原文抽掉 → 下游读语料 78 → 0，token 降到 1/4
//   N5：慢 rep == 胖 rep
//
// ★ 分析
//   P8 里的数字是**我在外面数**的 —— 它自己没有记忆，每轮都是全新的。
//   「我已经读了 26 份」这件事只存在于我的注入字符串里，**不在它的世界里**。
//   ⇒ 该治的层：`context`（它应该能看见自己）
//
// ★ 自变量（账本里放什么 —— 三档递进）
//   none   ：什么都不放（对照，就是现在的常态）
//   count  ：★ 每轮在**真正发出去的**内容里挂「你已调用 N 次 / 读过 K 份」
//   budget ：count + 真实上下文占用（`context.usage`）+ 阈值
//
// ★ 观测量
//   调用数 / token / 通过率 / ★ 它有没有「自己踩刹车」（后半段调用密度）
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Meter } from "./measure.ts";
import type { Task } from "./tasks.ts";

type Deps = {
  lab: { createAgent: (spec: Record<string, unknown>) => Promise<any>; cwd: string };
  MODEL: string;
  READ_WRITE: string[];
};

function textOf(m: { content?: unknown }): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: { text?: string }) => b.text ?? "").join("");
  return "";
}

export function ledgerSystem(deps: Deps) {
  const { lab, MODEL, READ_WRITE } = deps;
  return {
    id: "ledger",
    what: "F-1 自省账本 —— 每轮把「你自己做过什么」挂进真正发出去的内容里",
    async run(task: Task, params: Record<string, unknown>, cwd: string, progress?: { step: string; meter?: Meter }) {
      const meter = new Meter();
      if (progress) progress.meter = meter;
      const mode = String(params.mode ?? "none"); // none | count | budget | ahead
      const steps = Number(params.steps ?? 3);

      const taskText =
        `corpus/ 里有 ${task.corpus.length} 份材料，其中一些在讲同一件事。` +
        `找出所有重复组，写成 ${task.artifact}（形如 {"duplicates":[["M1","M2"]],"irrelevant":[]}）。`;

      let crashed: string | undefined;
      let ledgerLines = 0;
      for (let i = 0; i < steps; i++) {
        const n = i + 1;
        const role =
          n === 1
            ? "你负责摸底：看清 corpus/ 里有哪些材料、大致在说什么。不要下结论，只写你看到的。"
            : n === steps
              ? `你负责落盘：把分组结论写成 ${task.artifact}。**只有你能写产物。**`
              : "你负责去重：找出哪些材料在讲同一件事。";
        const agent = await lab.createAgent({
          id: `L${n}-${Date.now()}`,
          model: MODEL,
          role,
          permissions: { only: READ_WRITE },
        });
        if (progress) progress.step = `账本档 ${mode} · 第 ${n} 棒`;
        meter.watch(agent, { role: `S${n}`, depth: n });

        // ★ 账本主体：统计它**自己**做过什么（我们代它记，但挂在它收到的内容里）
        const mine = { calls: 0, read: new Set<string>(), tools: new Map<string, number>() };

        if (mode !== "none") {
          // ★★ 关键修正（第一轮实测教训）：
          //   把账本挂在**消息尾部**没用 —— 实测 budget 档 S2 依然读 37 次。
          //   因为下一轮请求时它在**最前面**看到的是自己的任务提示，账本埋在历史末尾。
          //   ★ P8 为什么有效：挂在 `onResult`（**工具返回值**）上 ——
          //     每读完一份，返回值里就带着账 —— **它正在读的那一刻就看见了**。
          //   ⇒ 改成挂在 toolResult 上（与 P8 同构）。
          agent.tools.onResult((result: { content?: { type: string; text?: string }[] }, ctx?: { toolName?: string }) => {
            // ★ P8 的签名实测只有 (result)。勉强拿 ctx（可能 undefined）——拿不到名字时就不分工具。
            const name = String(ctx?.toolName ?? "");
            mine.calls++;
            if (name) mine.tools.set(name, (mine.tools.get(name) ?? 0) + 1);
            // 从**返回值正文**里数「这是哪份材料」（路径不在 result 里，那就从正文识别）
            const body = (result?.content ?? []).map((c) => c.text ?? "").join("");
            const mm = /笔记\s*([0-9]+[a-z])|(杂记\s*[0-9]+)/.exec(body);
            if (mm) mine.read.add(mm[0].replace(/\s+/g, ""));

            const u = agent.context.usage;
            let line = "";
            if (mode === "ahead") {
              // ★★ 前瞻版：给「还剩多少」而不是「用了多少」（P8 的形状）
              //   而且把「漏掉的代价」写出来 —— 防止它为省而偷工。
              const left = Math.max(0, task.corpus.length - mine.read.size);
              line +=
                `\n── 📒 进度账本 ──\n` +
                `全库 **${task.corpus.length}** 份，你已读到 **${mine.read.size}** 份，**还剩 ${left} 份没读**。`;
              line += left > 0
                ? `\n⚠ **还剩 ${left} 份必须读完** —— 漏掉任何一组重复都会导致全错。别为了省而少读。`
                : `\n✅ 全库已读完 —— 现在下结论、写产物，不要再读。`;
              line += `\n────────────────`;
            } else {
              const toolStr = [...mine.tools.entries()].map(([k, v]) => `${k}×${v}`).join("、") || "（记不全）";
              line +=
                `\n\n─── 📒 你的账本（系统代记）───\n` +
                `已调用工具 ${mine.calls} 次：${toolStr}\n` +
                `已读到 ${mine.read.size}/${task.corpus.length} 份材料${mine.read.size ? "：" + [...mine.read].slice(-10).join("、") : ""}`;
              if (mode === "budget") {
                const pct = u?.percent != null ? (u.percent * 100).toFixed(0) : "?";
                line += `\n上下文已用 **${u?.tokens ?? "?"}** token（${pct}%）`;
                line += `\n⚠ 查过的就别再查 —— 全库只有 ${task.corpus.length} 份。`;
              }
              line += `\n─────────────────────`;
            }
            ledgerLines++;
            const orig = (result?.content ?? []).map((c) => c.text ?? "").join("");
            return { content: [{ type: "text" as const, text: `${orig}${line}` }] };
          });
        }

        try {
          const res = await agent.io.prompt(n === 1 ? taskText + "\n\n" + role : role);
          if (res.error) crashed = `S${n} 轮失败：${res.error}`;
        } catch (e) {
          crashed = `S${n} 崩了：${(e as Error).message}`;
        }
        if (crashed) break;
      }

      meter.settle();
      const p = join(cwd, task.artifact);
      const text = existsSync(p) ? readFileSync(p, "utf8") : null;
      meter.dispose();
      return { meter, text, structured: { _ledger: { mode, ledgerLines } }, crashed };
    },
  };
}
