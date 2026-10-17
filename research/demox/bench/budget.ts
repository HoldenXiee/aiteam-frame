// β 实验：能不能给它造一个它现在没有的「感官」—— 代价知觉
//
// ★ 这是「换角度」框架的第二根支柱，也是 DESIGN.md 丙类的正面入口
//   P1 说「它看不见自己的代价」（一条**限制**，导致"别指望它自省"）
//   β 换个问法：★ **能不能通过代码给它装上这个感官？**
//
// ★ 三个感官档（自变量 = 每次工具返回里注入什么）
//   none       不给（对照）
//   cost       每次返回附 `[已用 N 次调用 / M token]`
//   budget     ★ 附代价 **+ 一个软上限**（"超过 K 次就该收尾了"）
//
// ★ 为什么 budget 档是关键
//   若"给数字"有效（cost）→ 它其实能自省，只是没人告诉它
//   若"给数字"无效但"给数字+阈值"有效 → ★ 它需要的不是数据，是**判据**
//   若都无效 → P1 的解释（"看不见"）要改写成"看见了也不管"
//
// 观测量：总调用数、总 token、★ 是否在预算内收尾、任务成败
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Meter } from "./measure.ts";
import type { Task } from "./tasks.ts";

type Deps = {
  lab: { createAgent: (spec: Record<string, unknown>) => Promise<any>; cwd: string };
  MODEL: string;
  READ_WRITE: string[];
};

export function budgetSystem(deps: Deps) {
  const { lab, MODEL, READ_WRITE } = deps;
  return {
    id: "budget",
    what: "β 代价知觉：none / cost / budget —— 能不能用代码给它装上「我花了多少」",
    async run(task: Task, params: Record<string, unknown>, cwd: string, progress?: { step: string; meter?: Meter }) {
      const meter = new Meter();
      if (progress) progress.meter = meter;
      if (progress) progress.step = "开始（budget）";
      const mode = String(params.cost ?? "none"); // none | cost | budget
      const limit = Number(params.callLimit ?? 25);

      const agent = await lab.createAgent({
        id: `budget-${mode}-${Date.now()}`,
        model: MODEL,
        role: "你独自完成整个任务。用 read 看材料，用 write 写产物。",
        permissions: { only: READ_WRITE },
      });

      let calls = 0;
      let overrun = false;
      if (mode === "none") {
        agent.on("tool_result", () => {
          calls++;
        });
      } else {
        // ★ 只在**工具返回**里注入代价 —— 不改任务、不改角色
        agent.tools.onResult((result: { content?: { type: string; text?: string }[] }) => {
          calls++;
          const orig = (result?.content ?? []).map((c) => c.text ?? "").join("");
          let head = `[已用 ${calls} 次工具调用]`;
          if (mode === "budget") {
            const left = limit - calls;
            if (left > 0) head += ` [还剩 ${left} 次就该收尾了]`;
            else {
              overrun = true;
              head += ` *** 已超出 ${limit} 次 —— 请立刻用 write 落盘你现在的结论 ***`;
            }
          }
          return { content: [{ type: "text", text: `${head}\n${orig}` }] };
        });
      }

      meter.watch(agent, { role: `solo-${mode}`, depth: 1 });
      let crashed: string | undefined;
      try {
        const res = await agent.io.prompt(task.brief);
        if (res.error) crashed = `轮失败：${res.error}`;
      } catch (e) {
        crashed = (e as Error).message;
      }
      meter.settle();
      if (progress) progress.step = "读产物";
      const p = join(cwd, task.artifact);
      const text = existsSync(p) ? readFileSync(p, "utf8") : null;
      meter.dispose();
      return {
        meter,
        text,
        structured: { _budget: { mode, calls, overrun, limit } },
        crashed,
      };
    },
  };
}
