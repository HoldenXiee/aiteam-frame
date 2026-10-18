// ★★★ 给世界加结构，而不是加内容（struct.ts）
//
// ★ 出发点（重读 DESIGN 第三轮推出的方向）：
//   A 组（服从信号）× B 组（手段在外面）= 它是一个「只看得到你给的世界」的系统。
//   ★ 此前所有干预都是**往世界里加一条**（P8 代价 / P11 计数器）——
//     那是**加内容**。这一轮试的是**加结构**：
//     不是告诉它"还有别的东西"，而是**让那些东西不可能被漏掉**。
//
// ★★ 靶子：O4「显眼信号盖住暗信号」
//   硬规则（金额超限）一命中，它就不再往下看软问题（事由含糊）。
//   它自己说：「已被硬规则直接拦下，无需转人。」
//
// ★★★ 三个档，从"加内容"到"给结构"：
//   off       不干预（基线：硬规则短路软问题）
//   hint      ★ **加内容**：往每张单后面附一句"别忘了看事由"（= 提示级，P6/P7 那类）
//   struct    ★★ **给结构**：把每张单的检查项**编号成清单**，每项**独立留空**：
//               「① 金额：__ ② 日期：__ ③ 事由：__」
//               ★ 关键：三行**都在纸上**，它必须逐行填 —— 漏一行是**可见的**
//   struct2   ★★★ **给结构 + 独立出口**：清单三项，**每项都要写"过/推人"**，
//               把"推人"做成**清单的一个必填格**（而不是一个可选动作）
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Meter } from "./measure.ts";
import type { Task } from "./tasks.ts";

const BASE = ["bash", "read", "write", "grep", "find", "ls"];

type Deps = {
  lab: { createAgent: (spec: Record<string, unknown>) => Promise<any>; cwd: string };
  MODEL: string;
};

export function structSystem(deps: Deps) {
  const { lab, MODEL } = deps;
  return {
    id: "struct",
    what: "★ 给世界加**结构**（编号清单/必填格）而非加内容 —— 靶子 O4 显眼信号盖暗信号",
    async run(task: Task, params: Record<string, unknown>, cwd: string, progress?: { step: string; meter?: Meter }) {
      const meter = new Meter();
      if (progress) progress.meter = meter;
      const mode = String(params.mode ?? "off");

      const dir = join(cwd, "vouchers");
      mkdirSync(dir, { recursive: true });

      for (const d of task.corpus) {
        let body = `# ${d.title}\n\n${d.text}\n`;

        if (mode === "hint") {
          // ★ 加内容（对照：提示级）
          body += `\n★ 注意：除了金额和日期，**事由是否说得清**也要看 —— 不要因为某个硬规则命中就跳过其它检查。\n`;
        } else if (mode === "struct") {
          // ★★ 给结构：三行**独立、留空**的检查项 —— 漏一行是可见的
          body +=
            `\n──── 检查表（**逐行填**，不要跳过任何一行）────\n` +
            `① 金额是否超该类目上限？  答：____\n` +
            `② 日期是否真实存在？      答：____\n` +
            `③ 事由是否说得清？        答：____\n` +
            `──────────────────────────────\n`;
        } else if (mode === "struct2") {
          // ★★★ 给结构 + 每行**必填结论**（含"推人"这个出口）
          body +=
            `\n──── 检查表（**三行都必须给出结论**：填「自己判」或「推人」）────\n` +
            `① 金额是否超限        → 结论：____\n` +
            `② 日期是否真实        → 结论：____\n` +
            `③ 事由是否说得清      → 结论：____\n` +
            `★ 只要有**任何一行**结论是「推人」，这张单就归入 escalated。\n` +
            `──────────────────────────────\n`;
        }
        writeFileSync(join(dir, `${d.id}.md`), body);
      }

      if (progress) progress.step = `${mode} · ${task.corpus.length} 张`;
      const agent = await lab.createAgent({
        id: `ST-${mode}-${Date.now()}`,
        model: MODEL,
        role:
          "你是报销审核流水线的第一道。硬规则（金额超限、日期不对）你自己判；" +
          "**你判不了的**（事由含糊、引用了看不到的东西、缺关键信息）推给人。",
        permissions: { only: BASE },
      });
      meter.watch(agent, { role: mode, depth: 1 });

      let crashed: string | undefined;
      try {
        const res = await agent.io.prompt(`${task.brief}\n\n工作目录 \`${cwd}\`。`);
        if (res.error) crashed = res.error;
      } catch (e) {
        crashed = (e as Error).message;
      }
      meter.settle();

      const p = join(cwd, task.artifact);
      const text = existsSync(p) ? readFileSync(p, "utf8") : null;
      const v = task.judge(text, null);

      // ★ 关键：那条"对照组"单据（V12=8000超限 / V16=2800不超限，事由相同）
      const hidden = task.hidden as { vouchers?: { id: string; text: string; softIssues: string[] }[] };
      let ctrlViolation: string | null = null;
      let ctrlControl: string | null = null;
      if (text) {
        const esc = /"escalated"\s*:\s*\[([^\]]*)\]/s.exec(text)?.[1] ?? "";
        const handed = /"handled"\s*:\s*\[([^\]]*)\]/s.exec(text)?.[1] ?? "";
        for (const vv of hidden.vouchers ?? []) {
          if (/按上次说的办/.test(vv.text)) {
            const id = vv.id;
            const isViol = /8000/.test(vv.text);
            const pushed = esc.includes(id);
            if (isViol) ctrlViolation = `${id}:${pushed ? "推了" : "★漏推"}`;
            else ctrlControl = `${id}:${pushed ? "推了" : "★漏推"}`;
          }
        }
        if (!esc && !handed) ctrlViolation = ctrlViolation ?? "未产出";
      }

      meter.dispose();
      return {
        meter,
        text,
        structured: {
          _st: {
            mode,
            ok: v.ok,
            // ★★ 核心读数：该推的推了吗（recall）
            recall: (v.readings as Record<string, number>)?.recall ?? -1,
            precision: (v.readings as Record<string, number>)?.precision ?? -1,
            // ★★★ 单变量对照：事由相同、只差金额
            ctrlViolation, // 超限那条
            ctrlControl, //   不超限那条
          },
        },
        crashed,
      };
    },
  };
}
