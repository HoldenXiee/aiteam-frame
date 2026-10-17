// ★★★ 临界减速预警（warn.ts）—— 理论桥梁②的可执行版本
//
// 理论：Scheffer et al. 2001（Nature 413:591）—— 系统接近临界转变时，"回到稳态的恢复时间"上升。
// ★ 我们的优势：生态学只能被动观测，而我能**主动注入扰动**并测恢复时间。
//
// 做法：3 棒管线（S1 摸底 → S2 去重 → S3 成文）。
//   ★ 每一轮之后，用 io.steer 注入一句**无关的话**（"顺便说一句，今天的天气不错"），
//     然后数**它需要几轮才回到原来在做的事**上 = 恢复时间。
//   若"恢复时间"在成本跃迁前可测地上升 → 得到在线预警指标。
//
// 对照：off（不测）/ warn（每轮测恢复时间）
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Meter } from "./measure.ts";
import type { Task } from "./tasks.ts";

const BASE = ["bash", "read", "write", "grep", "find", "ls"];

type Deps = { lab: { createAgent: (spec: Record<string, unknown>) => Promise<any>; cwd: string }; MODEL: string };

export function warnSystem(deps: Deps) {
  const { lab, MODEL } = deps;
  return {
    id: "warn",
    what: "★ 临界减速：主动注入扰动，测「恢复时间」当相变预警",
    async run(task: Task, params: Record<string, unknown>, cwd: string, progress?: { step: string; meter?: Meter }) {
      const meter = new Meter();
      if (progress) progress.meter = meter;
      const mode = String(params.mode ?? "warn");
      const probe = String(params.probe ?? "distract");
      const dir = join(cwd, "corpus");
      mkdirSync(dir, { recursive: true });
      for (const d of task.corpus) writeFileSync(join(dir, `${d.id}.md`), `# ${d.title}\n\n${d.text}\n`);

      const agent = await lab.createAgent({
        id: `WN-${mode}-${Date.now()}`,
        model: MODEL,
        role:
          "你负责把 corpus/ 里的材料**逐份读完**，找出讲同一件事的分组，最后写进 " + task.artifact + "。\n" +
          "★ 期间我会时不时插话，那些插话**与任务无关** —— 请自行判断，不要被带跑。",
        permissions: { only: BASE },
      });
      meter.watch(agent, { role: mode, depth: 1 });

      // ★ 记录插话与"之后多少轮才回到读取"
      const marks: { turn: number; kind: string }[] = [];
      let turn = 0;
      const readsPerTurn: number[] = [];
      let readsThisTurn = 0;
      let pendingProbeAt = -1;
      let recoveredAt = -1;

      agent.onAny((ev: any) => {
        if (ev?.type === "message_end" && ev.message?.role === "assistant") {
          readsPerTurn.push(readsThisTurn);
          readsThisTurn = 0;
          turn++;
          // ★ 是否恢复（这一轮又有 read）
          if (pendingProbeAt >= 0 && ev.message?.content?.some?.((c: any) => c?.type === "tool_use")) {
            const hasRead = ev.message.content.some((c: any) => c?.type === "tool_use" && /read|bash|grep/.test(c?.name ?? ""));
            if (hasRead && recoveredAt < 0) recoveredAt = turn;
          }
        }
      });
      agent.tools.onResult((ev: any) => {
        if (ev?.toolName === "read") readsThisTurn++;
      });

      // 主循环：每读到 N 份就插一句
      let injected = 0;
      const total = task.corpus.length;
      let res = await agent.io.prompt(
        `corpus/ 有 ${total} 份材料，请全部读完并分组。工作目录 \`${cwd}\`，产物 \`${task.artifact}\`。`,
      );

      // ★ 干扰注入：任务跑起来后，按轮次插话
      if (mode === "warn" && probe !== "none") {
        const texts: Record<string, string> = {
          distract: "顺便说一句，今天的天气不错。不用回我，继续做你的事。",
          chitchat: "对了，你平时喜欢喝咖啡还是茶？不用回我。",
          noise: "这是一条与任务无关的测试消息，请忽略它。",
        };
        for (let k = 0; k < 1; k++) {
          try {
            pendingProbeAt = turn;
            recoveredAt = -1;
            agent.io.steer(texts[probe] ?? texts.distract);
            injected++;
            marks.push({ turn, kind: probe });
            await new Promise((r) => setTimeout(r, 100));
          } catch { /* 已结束 */ }
        }
      }

      meter.settle();
      const p = join(cwd, task.artifact);
      const text = existsSync(p) ? readFileSync(p, "utf8") : null;
      const turns = agent.observe.turns.map((t: any) => t.total ?? 0);
      meter.dispose();
      return {
        meter, text,
        structured: {
          _warn: {
            mode, probe, injected,
            turnTokens: turns,
            peakTurn: turns.length ? Math.max(...turns) : 0,
            // ★★ 关键读数：扰动后多少轮才恢复（=1 表示马上恢复）
            recoveryTurns: recoveredAt >= 0 && pendingProbeAt >= 0 ? recoveredAt - pendingProbeAt : -1,
            turnsTotal: turns.length,
          },
        },
        crashed: res?.error,
      };
    },
  };
}
