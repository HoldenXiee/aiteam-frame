// ★ T-H · 「意图 → 落地」（族 B，研究/写作类）—— DESIGN 第 60 行最直接的测试
//
// ★ DESIGN 原话
//   「**让人的意图/想法落地**」「人是以新的工具去"劳动"……**让人更好的利用这个工具**」
//
// ★★ 设计核心：**人给的是「意图」，不是「题目」**
//   此前所有任务，brief 都是我写好的**明确题目**（"找出重复组，写成 JSON"）。
//   ★ 那等于**我把人的思考替人做完了** —— 人只剩下"看结果"。
//
//   这条族里，人只给**一句话的模糊意图**：
//     「我想知道我们那堆设计笔记里，关于「上下文」的说法有没有重复和打架的地方」
//   ★ 而从这句话到"一份可核对的、有出处的短报告"，中间**全是要自己补的判断**：
//     · 要查哪些笔记？（意图里没说）
//     · "重复"和"打架"分别指什么？（要自己定义）
//     · 报告给谁看？（决定了详略）
//     · 结论怎么让人信？（★ 要带出处）
//   ★★ **这个落差就是人的价值所在** —— 也是"意图落地"要研究的东西。
//
// ★ 判据（三条，都不看它说了什么漂亮话）
//   ① 覆盖：★ 意图里隐含的**子问题**，它拆出来了吗
//   ② 溯源：★★ 每条断言**能不能对回原文**（真实调研里的"每一句话都要对回原文"）
//   ③ ★ 自洽：同一件事不能在两处给矛盾的结论
//
// ★ 判据纪律：ground truth 是"哪些笔记在讲同一件事 / 哪些互相矛盾"（由代码生成）
import type { Doc, Task, TaskVerdict } from "./tasks.ts";

export interface IntentTask extends Task {
  /** ★ 人给的那一句话（模糊意图）—— 这是本任务的核心自变量 */
  intent: string;
  /** 意图里隐含的子问题（**不给 agent**，判据用） */
  hiddenQuestions: string[];
}

/** 笔记池：关于"上下文"的若干说法，其中**有些重复、有些矛盾** */
const NOTES: [string, string, string][] = [
  // [id, 说法, 类别] 类别：same=与别的重复 / conflict=与别的打架 / solo=独一份
  ["N1", "上下文共享比文件交接便宜，因为它消灭了重复读", "same"],
  ["N2", "把上游看过的直接给下游，总成本反而降了", "same"], // 与 N1 重复
  ["N3", "上下文越长越好，信息越多判断越准", "conflict"],
  ["N4", "上下文必须裁剪，塞太多会让模型抓不住重点", "conflict"], // 与 N3 打架
  ["N5", "结构化交接面是代码强制保真的前提", "solo"],
  ["N6", "想让代码接住判断，得先让判断落成数据", "solo"],
  ["N7", "压缩会丢信息，能不压就别压", "conflict"],
  ["N8", "该压就得压，不压迟早撑爆窗口", "conflict"], // 与 N7 打架
  ["N9", "账本要给「还剩多少」，不是「已用多少」", "solo"],
  ["N10", "轨迹共享比让下游重读原文更便宜", "same"], // 与 N1/N2 同族（★ 更隐蔽的重复）
];

export function buildIntentTask(n: number, seed = 1): IntentTask {
  const notes = NOTES.slice(0, Math.max(6, Math.min(n, NOTES.length)));
  const corpus: Doc[] = notes.map(([id, text]) => ({ id, title: `设计笔记 ${id}`, text }));

  // ★ ground truth
  const dupGroups = [["N1", "N2", "N10"], ["N7", "N8"]]; // 说法重复的
  const conflicts = [["N3", "N4"], ["N7", "N8"]]; // 互相打架的
  const solo = notes.filter(([id]) => !dupGroups.flat().includes(id) && !conflicts.flat().includes(id)).map(([id]) => id);

  return {
    id: `T-H-${notes.length}`,
    // ★★ 这就是「人的意图」—— 一句话，模糊，不完整
    intent:
      "我想知道我们那堆设计笔记里，关于「上下文」的说法有没有重复和打架的地方。" +
      "给我一份**简短的**报告，我要拿它去跟同事讨论，所以**每条结论我得能自己核对回去**。",
    brief:
      `★ 这是我们的研究员交代的一句话：\n\n` +
      `「${"" /* 占位，运行时替换 */}」\n\n` +
      `笔记在 \`notes/\`（一份一个文件，N1..N${notes.length}）。\n` +
      `★ 产物写成 \`report.md\`，**Markdown**，让人能直接读。\n\n` +
      `★ 要求（听清楚了）：\n` +
      `1. **简短** —— 他要拿去讨论，不是要读长篇。\n` +
      `2. ★ **每条结论都要带出处**（引用 N 几）—— 他**要能自己核对回去**。\n` +
      `3. 他说的是「**重复**和**打架**」两件事 —— 这两件事**不一样**，分开写。\n` +
      `4. 别只列现象 —— 说清「哪几条在说同一件事」「哪两条互相矛盾」。`,
    corpus,
    hidden: { dupGroups, conflicts, solo, notes },
    hiddenQuestions: ["找出重复的说法", "找出互相矛盾的说法", "分开呈现这两类", "每条结论有出处"],
    artifact: "report.md",
    judge: (text) => judgeIntent(text, dupGroups, conflicts),
    measures: "意图落地：模糊意图 → 可核对的产物（覆盖 / 溯源 / 自洽）",
    difficulty: "★ 意图模糊（没说查哪些、没说重复和打架的界线）—— 全靠它自己补判断",
  };
}

/** ★ 判据：三条，都不看它写得好不好看 */
export function judgeIntent(text: string | null, dupGroups: string[][], conflicts: string[][]): TaskVerdict {
  const failed: string[] = [];
  const items: Record<string, boolean> = {};
  const readings: Record<string, number> = {};
  if (!text) return { ok: false, items: {}, failed: ["产物不存在"], readings: {} };

  const refs = new Set([...text.matchAll(/\bN(\d{1,2})\b/g)].map((m) => `N${Number(m[1])}`));
  // ★ 每一条"带出处的行"（含 N 编号的行）
  const linesWithRefs = text.split("\n").filter((l) => /\bN\d{1,2}\b/.test(l) && l.trim().length > 8);
  readings.citedIds = refs.size;
  readings.linesWithRefs = linesWithRefs.length;
  readings.length = text.length;

  // ① 覆盖：重复组有没有被认出来
  const foundDup = dupGroups.filter((g) => g.filter((id) => refs.has(id)).length >= g.length - 1).length;
  readings.dupFound = foundDup;
  readings.dupTotal = dupGroups.length;
  items.找出重复 = foundDup >= Math.max(1, dupGroups.length - 1); // 允许漏一组（10 条笔记里的人也会漏）

  // ② 覆盖：矛盾组有没有被认出来
  const foundConflict = conflicts.filter((g) => g.every((id) => refs.has(id))).length;
  readings.conflictFound = foundConflict;
  readings.conflictTotal = conflicts.length;
  items.找出矛盾 = foundConflict >= 1;

  // ③ ★ 溯源：结论带得出出处吗（真实调研的标准：「每一句话都要对回原文」）
  //   判据：含结论的段落里，有没有 N 编号
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 30 && !p.startsWith("#"));
  const traced = paragraphs.filter((p) => /\bN\d{1,2}\b/.test(p)).length;
  readings.paragraphs = paragraphs.length;
  readings.tracedParagraphs = traced;
  readings.traceRate = paragraphs.length ? traced / paragraphs.length : 0;
  items.溯源 = paragraphs.length > 0 && traced / paragraphs.length >= 0.7;

  // ④ ★ 两件事分开写了吗（他说的是"重复**和**打架"）
  const hasDupSection = /重复|一回事|同样|同义/i.test(text);
  const hasConflictSection = /矛盾|打架|冲突|相反|不一致/i.test(text);
  items.分开两类 = hasDupSection && hasConflictSection;

  // ⑤ 简短（他要拿去讨论）—— 超过 3500 字就不叫简短了
  readings.chars = text.length;
  items.简短 = text.length <= 3500;

  if (!items["找出重复"]) failed.push("没找出重复的说法");
  if (!items["找出矛盾"]) failed.push("没找出互相矛盾的说法");
  if (!items["溯源"]) failed.push("多数结论没带出处 —— 他核对不回去");
  if (!items["分开两类"]) failed.push("「重复」和「打架」没分开写");
  if (!items["简短"]) failed.push(`太长（${text.length} 字，他要求简短）`);

  return { ok: failed.length === 0, items, failed, readings };
}
