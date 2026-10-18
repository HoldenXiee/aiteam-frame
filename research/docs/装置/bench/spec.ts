// ★★★ 给定值信道实验（spec.ts）—— 理论桥梁① 的可执行版本
//
// 理论：Holmström & Milgrom 1991（多任务代理）—— 只给部分可计分指标会**挤出**不可计分任务。
//       Ashby 必要变异度 —— 给定值信道容量有限。
//       Wiener —— 调节器需要**外生**的误差来源。
//
// ★ 问题（直接来自 DESIGN：「人的意图/想法落地」）：
//   **人到底该交代多少？** 此前 P14 测了"一句话 vs 列全"，只测了两点。这次**扫一条曲线**。
//
// 自变量：`instrCount` = 人为指令的条数（1 → 20）
//   ★ 关键设计：指令分两类
//     · **必要**（任务本身不可少的：读材料、分组、写产物）
//     · ★ **冗余**（重复/近义/可能冲突的：必须排序、必须引用、必须简短、必须分节...）
//   1 条 = 只说"把重复的组找出来"
//   20 条 = 必要 4 条 + 冗余 16 条（★ 冗余里**故意埋 2 条互相冲突的**）
//
// ★★ 因变量（三个）：
//   ① 质量（判据通过）
//   ② 成本（token）
//   ③ ★★★ **冲突率** —— 当两条指令矛盾时，它听谁的？（看它自己怎么说）
//
// 预测（倒 U 形）：成本单调升 / 质量先升后平 / ★ 冲突率单调升
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Meter } from "./measure.ts";
import type { Task } from "./tasks.ts";

const BASE = ["bash", "read", "write", "grep", "find", "ls"];

// ★ 必要指令（任务不可少的）—— ★ **按任务给**，不是写死一套
type InstrPack = { needed: string[]; redundant: string[] };
const PACKS: Record<string, InstrPack> = {
  // T-A：找重复组
  dup: {
    needed: [
      "读完 corpus/ 里的每一份材料",
      "找出讲同一件事的那些组",
      '★ 产物写成 answer.json，格式：{"duplicates": [["M3","M7"]], "irrelevant": ["M11"]}（duplicates=每组讲同一件事的编号；irrelevant=与其它都无关的）',
      "只写结论，别写过程",
    ],
    redundant: [],
  },
  // ★ T-G：报销审核（产物形状完全不同！）
  voucher: {
    needed: [
      "读完 vouchers/ 里的每一张报销单",
      "硬违规（金额超限、日期不对）自己判，事由含糊的你判不了",
      "产物写成 out.json，形如 {\"handled\":[{\"id\":\"V1\",\"verdict\":\"通过\",\"reason\":\"...\"}],\"escalated\":[{\"id\":\"V5\",\"reason\":\"...\"}]}",
      "★ 该推给人的要推，不该推的别推 —— 推错两边都有代价（漏推=业务出错；多推=白占人的时间）",
    ],
    redundant: [],
  },
};

// ★ 冗余指令（重复、近义、或可能冲突）—— 后两条**故意冲突**
const REDUNDANT_ALL = [
  "尽量全面，别漏掉任何一项",
  "要准，宁缺勿滥 —— 不确定就别写进去",           // ⚠ 与上一条张力
  "产物必须是合法 JSON",
  "JSON 里不要有注释",
  "字段名要写全",
  "每条结论至少 2 条依据",
  "单条依据不要单独成条",
  "如果能排序，按编号排序",
  "不要按字母序，按重要性排",                        // ⚠ 与上一条矛盾
  "结果要简短",
  "但要包含足够信息",
  "不要添加额外字段",
  "如果拿不准就保守一些",
  "尽量给出你的判断",
  "先检查一遍再写",
  "写完再自查一次",
];

type Deps = { lab: { createAgent: (s: Record<string, unknown>) => Promise<any>; cwd: string }; MODEL: string };

export function specSystem(deps: Deps) {
  const { lab, MODEL } = deps;
  return {
    id: "spec",
    what: "★ 给定值信道：扫「人为指令条数」1→20，测质量/成本/★冲突率",
    async run(task: Task, params: Record<string, unknown>, cwd: string, progress?: { step: string; meter?: Meter }) {
      const meter = new Meter();
      if (progress) progress.meter = meter;
      const n = Number(params.instrCount ?? 4);
      // ★ 目录名按任务给（T-A 是 corpus/、T-G 是 vouchers/）—— 写死会让换任务的数据**全部作废**
      const dirName = String(params.dirName ?? (String(params.pack) === "voucher" ? "vouchers" : "corpus"));
      const dir = join(cwd, dirName);
      mkdirSync(dir, { recursive: true });
      for (const d of task.corpus) writeFileSync(join(dir, `${d.id}.md`), `# ${d.title}\n\n${d.text}\n`);

      // ★ 组装指令：前 4 条必要（★ 按任务选包），其后按需加冗余
      const pack = PACKS[String(params.pack ?? "dup")];
      // ★ verbose：把"产物规格"这条写啰嗦（**内容等价**，只是长）—— 用来分离"长度"与"难度"
      let needed = [...pack.needed];
      if (params.verbose === "1" || params.verbose === 1 || params.verbose === true) {
        needed = needed.map((t) =>
          t.startsWith("把分组写成") || t.startsWith("产物写成")
            ? `${t}
   （★ 说明：这里的 JSON 必须是**合法**的 JSON 文本；数组的每一项都必须是**字符串**，` +
              `不要写成对象；文件名必须**原样**照着 corpus/ 里看到的写，包括扩展名；` +
              `不要在 JSON 里加任何注释（\`//\` 或 \`/* */\` 都不行）；` +
              `不要把 JSON 包在 Markdown 代码块里；不要在 JSON 前后写任何解释性文字；` +
              `如果某项不清楚就按你最好的判断填，但**必须**让整体仍是一个合法 JSON）`
            : t,
        );
      }
      let list = [...needed.slice(0, Math.min(n, needed.length))];
      // ★ order=last：把"产物规格"那条挪到**最后**（分离"位置"这个变量）
      if (String(params.order ?? "first") === "last") {
        const spec = list.filter((t) => t.startsWith("把分组写成") || t.startsWith("产物写成"));
        const rest = list.filter((t) => !spec.includes(t));
        list = [...rest, ...spec];
      } else if (String(params.order ?? "first") === "first") {
        const spec = list.filter((t) => t.startsWith("把分组写成") || t.startsWith("产物写成"));
        const rest = list.filter((t) => !spec.includes(t));
        list = [...spec, ...rest];
      }
      for (let i = 0; i < Math.max(0, n - 4); i++) list.push(REDUNDANT_ALL[i % REDUNDANT_ALL.length]);
      const instr = list.map((t, i) => `${i + 1}. ${t}`).join("\n");

      if (progress) progress.step = `指令 ${n} 条`;
      const agent = await lab.createAgent({
        id: `SP-${n}-${Date.now()}`,
        model: MODEL,
        role: "你按下面列出的要求完成任务，把结果写进指定的产物文件。",
        permissions: { only: BASE },
      });
      meter.watch(agent, { role: `n=${n}`, depth: 1 });

      let crashed: string | undefined;
      try {
        const res = await agent.io.prompt(
          `corpus/ 里有 ${task.corpus.length} 份材料。\n\n★ 要求：\n${instr}\n\n` +
            `工作目录 \`${cwd}\`，产物 \`${task.artifact}\`。`,
        );
        if (res.error) crashed = res.error;
      } catch (e) {
        crashed = (e as Error).message;
      }
      meter.settle();

      const p = join(cwd, task.artifact);
      const text = existsSync(p) ? readFileSync(p, "utf8") : null;
      const v = task.judge(text, null);

      // ★★ 冲突率：看它有没有在产物/理由里"提到了冲突"
      const conflictSignal = text
        ? /(冲突|矛盾|互相抵触|不一致|两者不可兼得|无法同时|取舍)/.test(text)
        : false;

      meter.dispose();
      return {
        meter, text,
        structured: {
          _spec: {
            instrCount: n,
            redundantCount: list.length - 4,
            ok: v.ok,
            conflictSignal,
            chars: text?.length ?? 0,
            // ★ 质量细项
            items: JSON.stringify(v.items),
          },
        },
        crashed,
      };
    },
  };
}
