// ★ 修 bug 系统（T-F）—— 第一类**改造型**任务
//
// ★ 与之前所有系统的根本差别
//   此前：`permissions: { only: ["read","write","ls"] }` —— ★ **一步到底，无返工**
//   现在：`["bash","read","edit","write","grep","find","ls"]` —— ★ **多步、有返工**
//
// ★ 劳动形状（真实）
//   `bash` 跑测试看失败 → `grep` 定位 → `read` 看上下文 → `edit` 改 → `bash` 再跑 → **回去再改** → 绿
//
// ★ 自变量（两种介入方式）
//   solo    一个 agent 从头修到尾（对照）
//   guided  ★ 先用 `bash` 跑一次测试，**把失败的测试名喂给它**（省掉"发现失败"那一步）
//
// ★ 因变量
//   有效：`judgeRepair`（真跑 npm test）
//   效率：工具调用**种类分布**（这次终于能看到 edit/bash 用没用上）+ token + 轮数
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Meter } from "./measure.ts";
import { buildRepairTask, judgeRepair, type RepairTask } from "./tasks-repair.ts";
import type { Task } from "./tasks.ts";

const REPO_ROOT = process.cwd();

type Deps = {
  lab: { createAgent: (spec: Record<string, unknown>) => Promise<any>; cwd: string };
  MODEL: string;
};

/** ★ 改造型任务的工具集 —— 与前此的 READ_WRITE 完全不同 */
const REPAIR_TOOLS = ["bash", "read", "edit", "write", "grep", "find", "ls"];

export function repairSystem(deps: Deps) {
  const { lab, MODEL } = deps;
  return {
    id: "repair",
    what: "T-F · 修 bug 让测试过（改造型，多工具，真判据）",
    async run(task: Task, params: Record<string, unknown>, cwd: string, progress?: { step: string; meter?: Meter }) {
      const meter = new Meter();
      if (progress) progress.meter = meter;
      const mode = String(params.mode ?? "solo");
      const bugIds = String(params.bugs ?? "tools-noreload")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      // ① 建沙箱（真仓库副本 + 注入 bug）
      const sandbox = join(cwd, "repo");
      const rt: RepairTask = buildRepairTask({ bugIds, sandbox, artifact: "（产物就是修好的仓库）" }, REPO_ROOT);

      // ②（guided）先自己跑一次测试，把失败清单喂给它
      let hint = "";
      if (mode === "guided") {
        const before = judgeRepair(sandbox, 300_000);
        if (before.ok) {
          // ★ 装置自检：注入没生效就不该往下跑（否则测的是空气）
          throw new Error(`装置错：注入了 ${bugIds.join(",")} 但测试是绿的 —— 这个 bug 没有判别力`);
        }
        hint = `\n\n★ 我刚替你跑了一次 \`npm test\`，**失败的是这些**：\n${before.failed.map((f) => `  - ${f}`).join("\n")}\n从这些名字可以直接定位。`;
      }

      if (progress) progress.step = `${mode} · ${bugIds.join("+")}`;
      const agent = await lab.createAgent({
        id: `R-${mode}-${Date.now()}`,
        model: MODEL,
        role:
          "你是这个仓库的维护者。测试是红的，把它修绿。\n" +
          "★ 允许你改 `dev/test/` 以外的任何源码；**测试文件不许动**（那是判据）。\n" +
          "★ 改完必须自己跑一遍 `npm test` 确认真的绿了，再收工。",
        permissions: { only: REPAIR_TOOLS },
      });
      meter.watch(agent, { role: mode, depth: 1 });

      let crashed: string | undefined;
      try {
        // ★ 工作目录必须是沙箱（agent 在自己的副本上改，不动真仓库）
        const res = await agent.io.prompt(
          `${rt.brief}\n\n你的工作目录是 \`${sandbox}\`。所有 \`bash\` 命令都要在那里跑。${hint}`,
        );
        if (res.error) crashed = `${mode} 轮失败：${res.error}`;
      } catch (e) {
        crashed = `${mode} 崩了：${(e as Error).message}`;
      }

      meter.settle();
      // ③ ★ 判据：真跑测试（不是看它说什么）
      const verdict = judgeRepair(sandbox, 600_000);

      // ★ 工具种类分布 —— 改造型任务才有的读数
      const tools = meter.records[0]?.calls ?? [];
      const dist: Record<string, number> = {};
      for (const t of tools) dist[t] = (dist[t] ?? 0) + 1;

      // ★ 它有没有真动手改代码（edit/write 次数）
      const edits = (dist.edit ?? 0) + (dist.write ?? 0);
      const bashes = dist.bash ?? 0;
      // ★ 它有没有自己验证（改完之后又跑过测试）—— B8「把做完了当做对了」的直接检验
      const verified = bashes >= 2;

      meter.dispose();
      return {
        meter,
        text: verdict.ok ? "npm test 通过" : `npm test 失败：${verdict.failed.join(" / ")}`,
        structured: {
          _repair: {
            mode,
            bugs: bugIds,
            toolDist: dist,
            edits,
            bashes,
            verified,
            turns: agent.observe?.turns?.length ?? 0,
          },
        },
        crashed,
        // ★ 用真判据覆盖（系统的 verdict 由 scan.ts 从 text 推，这里我们直接给）
        judgeOverride: verdict,
        infraFailed: crashed !== undefined && tools.length === 0,
      };
    },
  };
}
