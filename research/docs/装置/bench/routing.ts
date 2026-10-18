// ★ 异常路由系统（T-G / 族 A）—— ★ 第一条「人真在里面干活」的任务
//
// ★ 设计依据：`研究/demox/任务设计重做.md` 族 A
//   真实出处：Vendr 10 万+ 文档；合规流水线审查时间降 78%、人工省 80%。
//   真实形状：**提取 → 规则校验 → 异常路由 → 人工队列 → 审计留痕**
//
// ★★ 为什么这条最重要（DESIGN 第 60 行）
//   「人是以新的工具去"劳动"……**让人更好的利用这个工具**」
//   ★ 此前所有任务里**人只在最后看判据** —— 人的位置是空的。
//   ★★ 这条里**人是流程的一环**，而且
//   ★★ **人工队列的长度 = 人的工作量 = 「人花了多少劳动」的可测化**。
//
// ★ 自变量（三档：把「人」放在不同位置）
//   none      ★ **没有人** —— agent 必须自己处理全部（包括它判不了的）
//   queue     ★ **有人工队列** —— agent 可以推给人（★ 但推错方向两边都有代价）
//   budgeted  队列 + ★ **人的工时预算**（"人今天只有 X 张的额度"）—— 逼它**省着用人的时间**
//
// ★ 因变量
//   路由准确：recall（该推的推了吗）/ precision（不该推的推了吗）
//   ★★ 人的工作量：humanQueue（队列长度）
//   效率：token / 工具分布
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Meter } from "./measure.ts";
import { judgeVoucher, buildVoucherTask, type Voucher } from "./tasks-voucher.ts";
import type { Task } from "./tasks.ts";

const MULTI_TOOLS = ["bash", "read", "write", "grep", "find", "ls"];

type Deps = {
  lab: { createAgent: (spec: Record<string, unknown>) => Promise<any>; cwd: string };
  MODEL: string;
};

export function routingSystem(deps: Deps) {
  const { lab, MODEL } = deps;
  return {
    id: "routing",
    what: "T-G · 异常路由 + 人工队列（人真在流程里）",
    async run(task: Task, params: Record<string, unknown>, cwd: string, progress?: { step: string; meter?: Meter }) {
      const meter = new Meter();
      if (progress) progress.meter = meter;
      const mode = String(params.mode ?? "queue");
      const n = task.corpus.length;

      // ① 铺单据（每张一个文件 —— 逼它用 ls/read/grep 而不是一次读完）
      const dir = join(cwd, "vouchers");
      mkdirSync(dir, { recursive: true });
      for (const d of task.corpus) writeFileSync(join(dir, `${d.id}.txt`), `${d.title}\n\n${d.text}\n`);

      // ★ 一点**真实的不方便**：另有一份规则手册（硬规则在里边，软问题不在）
      writeFileSync(
        join(dir, "..", "RULES.md"),
        `# 报销审核规则（硬规则）\n\n` +
          `1. 单笔金额上限：交通费/办公费/差旅费/会议费 ≤ 5000；业务招待费/咨询费 ≤ 3000；固定资产 ≤ 50000\n` +
          `2. 日期必须在 2026 年内，且必须是真实存在的日期\n` +
          `3. 会计科目不能为空\n\n` +
          `★ 以上三条是**代码能查的**。\n` +
          `★ 除此之外的一切（事由说不清、引用了你看不到的东西、缺关键信息）—— **本手册不管**，\n` +
          `  那类问题得靠**人**。\n`,
      );

      // ② 三档的差别只在一句话
      let humanPart = "";
      if (mode === "none") {
        humanPart =
          `\n★ **没有人可以帮你** —— 你必须自己对每张单给出结论（通过 / 驳回）。\n` +
          `产物仍然是 \`out.json\`，把所有单都放进 \`handled\`，\`escalated\` 留空。`;
      } else if (mode === "queue") {
        humanPart =
          `\n★ **有一个人工队列**。你判不了的单据，放 \`escalated\` 推给人。\n` +
          `★ 两个方向都有代价：该推没推 → 业务判错；**不该推却推 → 白白占用人的时间**。`;
      } else {
        humanPart =
          `\n★ **有一个人工队列，但人今天只有 ${Math.max(2, Math.round(n / 6))} 张的额度**。\n` +
          `★ 所以推之前想清楚：**这张真的非人不可吗？** 额度用完你就只能自己判了。`;
      }

      if (progress) progress.step = `${mode} · ${n} 张单据`;
      const agent = await lab.createAgent({
        id: `RT-${mode}-${Date.now()}`,
        model: MODEL,
        role:
          "你是报销审核流水线的第一道。你的职责是：**能自己判的自己判，判不了的往上推**。\n" +
          "★ 规则手册在 `RULES.md`；单据在 `vouchers/`（一张一个文件）。\n" +
          "★ 不要靠肉眼扫 —— 用工具（`ls`/`grep`）系统地过一遍，硬规则能用代码算的就用代码算。",
        permissions: { only: MULTI_TOOLS },
      });
      meter.watch(agent, { role: mode, depth: 1 });

      const brief =
        `${task.brief}\n\n你的工作目录是 \`${cwd}\`。规则手册 \`RULES.md\`，单据目录 \`vouchers/\`。${humanPart}`;

      let crashed: string | undefined;
      try {
        const res = await agent.io.prompt(brief);
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

      const hidden = task.hidden as { escalated: string[]; selfHandle: string[] };
      const judgement = judgeVoucher(text, hidden.escalated, hidden.selfHandle);

      meter.dispose();
      return {
        meter,
        text,
        structured: {
          _routing: {
            mode,
            toolDist: dist,
            // ★★ 人的工作量 —— 这是本任务最重要的读数
            humanQueue: judgement.readings.humanQueue,
            recall: judgement.readings.recall,
            precision: judgement.readings.precision,
            missed: judgement.readings.missedEscalation,
            wrong: judgement.readings.wrongEscalation,
          },
        },
        crashed,
      };
    },
  };
}
