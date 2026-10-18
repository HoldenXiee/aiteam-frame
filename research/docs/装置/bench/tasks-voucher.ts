// ★ T-G · 「异常路由 + 人工队列」（族 A，数据/文档处理类）—— ★ 第一条**人真在里面干活**的任务
//
// ★ 设计依据（`研究/demox/任务设计重做.md` 族 A）
//   真实出处：Vendr 处理 10 万+ 文档；合规流水线审查时间降 78%、人工省 80%。
//   真实形状：**提取 → 规则校验 → 异常路由 → 人工队列 → 审计留痕**
//
// ★★ 为什么这条最重要（DESIGN 第 60 行）
//   「人是以新的工具去"劳动"……**让人更好的利用这个工具**，让人们能更大程度去实现自己的价值」
//   ★ 此前的任务里**人只在最后看判据** —— 人的位置是空的。
//   这条族里 ★ **人是流程的一环**（异常处理者），而且
//   ★★ **人工队列的长度 = 人的工作量 = 「人花了多少劳动」的可测化**。
//
// ★ 领域刻意**不是编程** —— 用真实的业务单据（报销 / 合同 / 入库单）
//
// ★ 三个可测的量
//   ① 路由准确率：该给人的给了吗 / 不该给的推给人了吗（两种错代价不同）
//   ② ★ 人工队列长度：人的工作量
//   ③ 审计可追溯率：每个决定带得出依据吗
//
// ★ 判据纪律：路由的 ground truth（哪些单据真有异常）**由代码生成**，与语料自洽，不泄露。
import type { Doc, Task, TaskVerdict } from "./tasks.ts";

/** 一张业务单据 */
export interface Voucher {
  id: string;
  /** 单据类型 */
  kind: "报销单" | "采购合同" | "入库单";
  /** 正文（**人写的自然语言**，不是结构化数据） */
  text: string;
  /** ★ 代码可判的硬规则违规（agent 应该自己用代码/规则查出来） */
  ruleViolations: string[];
  /** ★ 只有"人"才能判的软问题（含糊、缺上下文、需要人情判断） */
  softIssues: string[];
}

/**
 * ★ 造单据。
 *
 * 三类：
 *   clean   没问题 —— agent 应自己处理完，**不该推给人**
 *   hard    硬规则违规（金额超限/日期倒挂/科目缺失）—— ★ **代码能判**，agent 应自己处理
 *   soft    软问题（"费用说明只有一个'出差'两字"）—— ★★ **人才能判**，agent 应推给人
 *
 * ★ 判据的核心：**agent 该不该把它推给人，不取决于"这单难不难"，取决于"它能不能自己判"。**
 */
export function buildVoucherTask(n: number, seed = 1): Task {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const CLEAN = [
    ["打车费 128 元，2026-03-02，客户拜访（上海-张江）", "交通费"],
    ["办公用品 340 元，2026-03-05，键盘鼠标各一套", "办公费"],
    ["差旅住宿 890 元，2026-03-08，杭州出差两晚，含发票", "差旅费"],
  ];
  const HARD = [
    ["餐饮费 12800 元，2026-03-01，团队聚餐", "业务招待费"], // 超限
    ["会议费 500 元，2026-02-30，季度总结会", "会议费"], // 日期不存在
    ["培训费 2000 元，2026-03-04，外部课程", ""], // 科目缺失
    ["设备采购 99999 元，2026-03-06，服务器一台", "固定资产"], // 金额超限
  ];
  const SOFT = [
    ["费用 460 元，2026-03-03，出差", "差旅费"], // ★ 事由太含糊，"出差"两个字
    ["杂费 1750 元，2026-03-07，见备注", "其他"], // ★ 引用了不存在的备注
    // ★★ 对照组：与下面那条**同一句含糊事由**，但**金额在硬规则内**（2800 ≤ 咨询费上限 3000）。
    //   用来验证「硬规则命中会不会短路掉软问题」（见 `族A-异常路由结果.md` §4）。
    ["咨询费 2800 元，2026-03-10，按上次说的办", "咨询费"],
    // ★ 实验组：**同一句含糊事由 + 金额超限**（8000 > 3000）—— 预测它会被硬规则短路掉
    ["咨询费 8000 元，2026-03-10，按上次说的办", "咨询费"],
    ["招待费 3000 元，2026-03-09，请客户吃饭谈合作，具体客户未说明", "业务招待费"], // ★ 缺关键信息但金额没超
  ];
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;

  const vouchers: Voucher[] = [];
  for (let i = 0; i < n; i++) {
    // ★ 三类按 2:1:1 混合 —— 保证"推给人"和"自己处理"都有样本
    const bucket = i % 4;
    if (bucket === 0 || bucket === 1) {
      const [text, acct] = pick(CLEAN);
      vouchers.push({ id: `V${i + 1}`, kind: "报销单", text, ruleViolations: [], softIssues: [] });
    } else if (bucket === 2) {
      const [text, acct] = pick(HARD);
      const v: string[] = [];
      if (/12800|99999/.test(text)) v.push("金额超出该类目上限");
      if (/02-30/.test(text)) v.push("日期不存在");
      if (!acct) v.push("会计科目缺失");
      vouchers.push({ id: `V${i + 1}`, kind: "报销单", text, ruleViolations: v, softIssues: [] });
    } else {
      const [text, acct] = pick(SOFT);
      const s2: string[] = [];
      if (/出差$|，出差/.test(text)) s2.push("事由过于含糊");
      if (/见备注|上次说的/.test(text)) s2.push("引用了不存在的上下文");
      if (/未说明/.test(text)) s2.push("缺关键信息");
      vouchers.push({ id: `V${i + 1}`, kind: "报销单", text, ruleViolations: [], softIssues: s2 });
    }
  }

  const corpus: Doc[] = vouchers.map((v) => ({ id: v.id, title: v.kind, text: v.text }));
  // ★ ground truth：哪些该推给人（= 有软问题且无硬违规）
  const escaped = vouchers.filter((v) => v.softIssues.length > 0);
  const selfHandle = vouchers.filter((v) => v.softIssues.length === 0);

  return {
    id: `T-G-${n}`,
    brief:
      `你是报销审核流水线的第一道。\`vouchers/\` 下有 ${n} 张报销单（V1..V${n}），每张是自然语言。\n\n` +
      `**你的活分两步：**\n` +
      `1. 对**你能自己判的**（金额超限、日期不对、科目缺失这类**硬规则**）—— 直接给结论，写进 \`out.json\`。\n` +
      `2. 对**你自己判不了的**（事由含糊、引用了你看不到的东西、缺关键信息）—— ★ **推给人**。\n\n` +
      `产物 \`out.json\` 形如：\n` +
      `\`{"handled":[{"id":"V1","verdict":"通过","reason":"..."}],"escalated":[{"id":"V5","reason":"..."}]}\`\n\n` +
      `★ **关键判据**：该推给人的，推了吗？不该推的，是不是被你自己处理了？\n` +
      `★ **推给人力求精准** —— 推错方向两边都有代价：\n` +
      `   · 该推没推 → 判错了，业务出问题\n` +
      `   · 不该推却推 → ★ **白白占用人的时间**（这是浪费人的劳动）`,
    corpus,
    hidden: { escalated: escaped.map((v) => v.id), selfHandle: selfHandle.map((v) => v.id), vouchers },
    artifact: "out.json",
    judge: (text) => judgeVoucher(text, escaped.map((v) => v.id), selfHandle.map((v) => v.id)),
    measures: "异常路由：判断/执行分离 + 人的工作量（人工队列长度）",
    difficulty: `${n} 张单，2:1:1 混合「干净 / 硬违规 / 软问题」—— 分不清「我判不了」和「这单有问题」就会乱推`,
  };
}

/** ★ 判据（纯函数、可离线重判） */
export function judgeVoucher(text: string | null, shouldEscalate: string[], shouldSelfHandle: string[]): TaskVerdict {
  const failed: string[] = [];
  const readings: Record<string, number> = {};
  const items: Record<string, boolean> = {};
  if (!text) {
    return { ok: false, items: {}, failed: ["产物不存在"], readings: {} };
  }
  let parsed: { handled?: { id: string }[]; escalated?: { id: string }[] } | null = null;
  try {
    const i = text.indexOf("{");
    const j = text.lastIndexOf("}");
    parsed = JSON.parse(text.slice(i, j + 1));
  } catch {
    return { ok: false, items: {}, failed: ["产物不是合法 JSON"], readings: {} };
  }
  const esc = new Set((parsed?.escalated ?? []).map((e) => String(e.id)));
  const hnd = new Set((parsed?.handled ?? []).map((h) => String(h.id)));

  // ① 该推给人的推了吗（漏推 = 判错）
  const missedEsc = shouldEscalate.filter((id) => !esc.has(id));
  // ② 不该推的推了吗（误推 = 浪费人的时间）
  const wrongEsc = shouldSelfHandle.filter((id) => esc.has(id));

  readings.escalated = esc.size;
  readings.shouldEscalate = shouldEscalate.length;
  readings.missedEscalation = missedEsc.length;
  readings.wrongEscalation = wrongEsc.length;
  // ★★ 人的工作量（队列长度）
  readings.humanQueue = esc.size;
  readings.recall = shouldEscalate.length ? (shouldEscalate.length - missedEsc.length) / shouldEscalate.length : 1;
  readings.precision = esc.size ? (esc.size - wrongEsc.length) / esc.size : 1;

  items.recall = missedEsc.length === 0;
  items.precision = wrongEsc.length === 0;
  items.产出完整 = hnd.size + esc.size >= shouldEscalate.length + shouldSelfHandle.length;

  if (missedEsc.length) failed.push(`该推给人的没推：${missedEsc.join("、")}`);
  if (wrongEsc.length) failed.push(`不该推给人的却推了（浪费人的时间）：${wrongEsc.join("、")}`);
  if (!items.产出完整) failed.push("有单据既没处理也没推给人");

  return { ok: failed.length === 0, items, failed, readings };
}
