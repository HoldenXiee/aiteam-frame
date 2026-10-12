// 任务 T 的定义 + **产物判据**（唯一真源）。
//
// ★ 两个实验室都必须 import 这个文件，谁都不许自己写第二份判据。★
// 理由（主设计 §2）：判据一旦两边各写一份，就一定会在某次「差一点点」里被分别放松，
// 然后整个对比失去意义。
//
// ★ 判据只认产物，不认模型自述。★
// 模型说「我做完了」不算（主设计 §3.1）：否则「自由发挥」那几档天然占便宜（它更爱宣称成功），
// 实验立刻失去意义。
//
// 由 bench/prep.ts 铺语料 → 两边各自跑 → bench/measure.ts 抽指标 → bench/compare.ts 出对照表。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRADICTION_GROUPS,
  DISTRACTORS,
  DUPLICATE_GROUPS,
  TOPICS,
  CORPUS,
} from "./corpus.ts";

export { TOPICS } from "./corpus.ts";
export const REPORT_FILE = "report.md";
/** 中间产物目录（两边**都**走文件，见两份 README 的约定） */
export const DRAFT_DIR = "draft";

const CORPUS_IDS = new Set(CORPUS.map((d) => d.id));

/**
 * 交给 agent 的任务说明。
 *
 * ⚠️ 这段文字**两边一字不差**用的是同一份 —— 它是「同一个任务」这个前提的兑现。
 * 两边能不同的只有：谁来做、按什么顺序做、能不能派人（那是形态，不是任务）。
 */
export const TASK_BRIEF = [
  "工作目录里有一个 corpus/ 目录，里面是几十份原始材料，每份有唯一编号（形如 M1、M2…）。",
  "材料很多，不要指望一口气看完 —— 先看清有哪些，再决定怎么处理。",
  "",
  `请产出一份 ${REPORT_FILE}，满足四条要求：`,
  "",
  `① 覆盖下面 5 个主题，每个主题至少给一条依据：`,
  ...TOPICS.map((t) => `   - ${t.id}：${t.name}`),
  "② 去重：同一件事在两份材料里都说过时，只算一条，**不要写成两条依据**。",
  "③ 矛盾：若两份材料对同一件事给出相反结论，必须**成对**写明（形如「M5 说 X，M9 说不 X」）。",
  "④ 每一条依据都必须标出材料编号（如「依据：M1」）；**不许**使用 corpus/ 里不存在的编号。",
  "",
  "报告请按主题分节（每节标题以「## 」开头），每节末尾单独一行写出依据编号。",
].join("\n");

/** 判据逐项结果 —— 不只存一个 boolean，回看时要知道**差在哪一项**（主设计 §3.1） */
export interface Verdict {
  /** 五项全过 */
  ok: boolean;
  /** 5 个主题是否都出现了 */
  covered: boolean;
  /** 用到的编号是否都在语料里（false = 编造了 id） */
  idsValid: boolean;
  /** 重复组里有没有两组同时出现在同一节依据行上（false = 没去干净） */
  deduped: boolean;
  /** 矛盾组是否都成对写出来了 */
  contradictionPaired: boolean;
  /** 干扰材料没被当依据（false = 越界） */
  distractorClean: boolean;
  /** 逐组明细，后面分析要按组看「哪一组最难」 */
  dedupDetail: { group: string[]; ok: boolean }[];
  contradictionDetail: { group: string[]; ok: boolean }[];
  /** 未过的项，逐条人话 */
  failed: string[];
  /** 产物内容的哈希（判据改了可以拿旧记录核对「当时写的是什么」） */
  reportHash: string | null;
  /** 报告字数（判据之外的一个读数：让「自由 = 话多」在表里露出来） */
  reportChars: number;
}

/** 简易内容哈希：不引 crypto 依赖，只为「同一次运行的产物可识别」 */
function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * 这份文本里有没有**独立出现**这个编号。
 *
 * ★ 必须用词边界，不能用 includes ★
 * 实测踩过的坑：`"M18、M37".includes("M3")` 为 **true** —— "M37" 里含子串 "M3"；
 * 同理 "M27" 里含 "M7"、"M33" 里含 "M3"。
 * 用子串匹配会把无关条目全算成命中，去重判据整个失效（预跑时它把一个**合并得很完美**
 * 的报告判成了“M3、M7 没去干净”）。
 */
export function hasId(text: string, id: string): boolean {
  return new RegExp(`\\b${id}\\b`).test(text);
}

/**
 * 从一节里抠出「依据行」上的 id。
 *
 * 为什么要抠而不是全节找 id：正文里提到一个 id 有两种意思——
 *   · 「依据：M1、M3」 = **采信它**（这才是判据要看的）
 *   · 「M11 与主题无关，已排除」 = **提到它但没采信**
 * 用全节抠 id 会把后者也判成越界（首轮预跑就撞上了：B 明明处理对了却被判红）。
 * 所以只在「依据：」开头的那些行上找 id —— 那是 agent 自己声明的采信名单。
 */
function citedIds(section: string): Set<string> {
  const out = new Set<string>();
  const lines = section.split("\n");
  // ★ 第 6 次修正（第 4 次的一般化）★
  // 第 4 次只解决了「附录**自成一节**」的情况。实测又撞上一份报告，
  // 它把排除声明**直接附在最后一个主题节（T5）末尾**，没有另起一节：
  //     ## T5 …
  //     - …（M12、M31）
  //     另：M11、M21、M41 均为行政通知，与 T1–T5 五个主题都无关，未纳入正文。
  //     依据：M11、M21、M41          ← 被判成越界
  // 语义上这仍然是「声明排除」，不是「当论据」。所以规则要一般化成：
  //   **一行「依据」若紧跟的正文里说了“无关/未纳入”之类，它是在记录排除决定，不算采信。**
  const EXCLUDE_RE = /无关|不纳入|未纳入|不参与|排除|不属于|不在正文|不涉及|不采用/;
  let pending: string[] = [];
  for (const line of lines) {
    if (/^\s*依据\s*[：:]/.test(line)) {
      if (!EXCLUDE_RE.test(pending.join("\n"))) {
        for (const m of line.match(/\bM\d+\b/g) ?? []) out.add(m.toUpperCase());
      }
      pending = [];
      continue;
    }
    if (line.trim() && !/^#/.test(line)) pending.push(line);
  }
  return out;
}

/**
 * 一节里的「条目」= 列表项行（`- ` / `* ` / `1. ` 开头）。
 *
 * ★ 为什么去重要按条目而不是按节 ★
 * 这是本实验**最值钱的一次判据修正**，值得写清楚：
 *
 * 初版判据是「同一组的两个 id 不许出现在同一节的依据行上」，结果 **20 次运行、5 个组全部 0% 通过**。
 * 一个 0% 的通过率不是「模型都不行」，是**判据错了**。翻出实际报告一看：
 *
 *     - 逐轮裁剪优于压缩（M3 与 M7 讲的是同一件事——只算一条）：…… （M3、M7）
 *
 * 这正是任务要求的行为（「只算一条」→ 合并成一条），却被初版判据判成失败。
 * 正确语义是：**同一组不能散在多个条目里**（那才叫算了两条），而不是不能出现在同一行。
 * 所以改成数条目：一组 id 占据的条目数 ≥ 2 才算没去干净。
 *
 * （这次修正能落地，靠的是 JSONL 里存了 `reportText` 全文 —— 不重跑就能重判。）
 */
function entriesOf(section: string): string[] {
  // ★ 第 5 次修正（同一个语义错误的残留）★
  // 原来只认 bullet（`- ` / `* ` / `1. `）行。实测发现：当一份报告**用粗体段落而不是列表**
  // 写事实时（形如 `**压缩不如裁剪省**（M3、M7 合并）：…`），entries 为空 →
  // 退回「按节的依据行」判断 —— 那正是第 1 次修掉的旧 bug，于是
  // **一份把 M3/M7 合并得很好的报告又被判成没去干净**（B-main-04-50 实测）。
  //
  // 正确语义：一个「事实单元」= 一条 bullet，**或者**一段连续的非 bullet 正文。
  // （两者都是 markdown 里独立的一件事；而依据行是**节级**的，永远不能当事实单元。）
  const lines = section
    .split("\n")
    .filter((l) => !/^#/.test(l) && !/^\s*依据\s*[：:]/.test(l));
  const out: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) {
      out.push(cur.join("\n"));
      cur = [];
    }
  };
  for (const l of lines) {
    if (!l.trim()) {
      flush();
      continue;
    }
    if (/^\s*([-*]|\d+[.、)])\s+/.test(l)) {
      flush();
      out.push(l);
      continue;
    }
    cur.push(l);
  }
  flush();
  return out;
}

/**
 * 判一份 report.md。
 *
 * 全部判断都是**代码可判**的（主设计 §3.1）：
 *   · 主题覆盖 → 找主题 id
 *   · 编造 id  → 抠出所有「M数字」，看在不在语料 id 集合里
 *   · 去重     → 重复组的 id 不许散在**多个条目**里（合并成一条 = 对）
 *   · 矛盾     → 矛盾组的两份**必须出现在同一节**（并写）
 *   · 干扰     → 干扰材料不许进**依据行**
 *
 * ⚠️ 这些判据是**刻意的近似**：它们只能判「结构对不对」，判不了「内容对不对」。
 * 真要让判据更强，得加 LLM-as-judge —— 但那会引入第二个模型、又一条变量。本实验选择不引。
 * 这条限制写进结论里，不藏着。
 *
 * ★ 判据改过一轮（去重从「按节」改成「按条目」）★，详见 entriesOf 的注释。
 * 重判旧数据不需要重跑：用 judgeText(record.reportText)（JSONL 里存了全文）。
 */
export function judge(cwd: string): Verdict {
  const reportPath = join(cwd, REPORT_FILE);
  if (!existsSync(reportPath)) return judgeText(null);
  return judgeText(readFileSync(reportPath, "utf8"));
}

/** 纯函数版：只吃产物全文。重判旧数据、写测试都用它 */
export function judgeText(text: string | null): Verdict {
  const failed: string[] = [];

  if (text === null) {
    return {
      ok: false,
      covered: false,
      idsValid: false,
      deduped: false,
      contradictionPaired: false,
      distractorClean: false,
      dedupDetail: [],
      contradictionDetail: [],
      failed: [`产物不存在：${REPORT_FILE}`],
      reportHash: null,
      reportChars: 0,
    };
  }

  const reportChars = text.length;

  // ── 按「## 」分节。每节单独判重复/矛盾（要求它们出现在**同一节**里） ──
  const sections = text
    .split(/^## /m)
    .slice(1) // 去掉首个 ## 之前的前言
    .map((s) => "## " + s);

  // ── 只认「依据行」上抠出来的 id（详见 citedIds 的注释） ──
  // allIds：全文所有提到过的 id（用于「编造」检查 —— 提到一个不存在的编号就是编造，
  //         不论它在正文还是依据行；这条比「采信」宽，是故意的）
  const allIds = new Set((text.match(/\bM\d+\b/g) ?? []).map((s) => s.toUpperCase()));

  /**
   * 这一节是不是主题节。
   *
   * ★ 判据要严到「标题**以主题 id 开头**」★
   * 实测：一份报告的附录标题是「## 附：与 T1–T5 无关的材料」——它含 "T1"，
   * 但显然不是主题节（它是声明「这些材料无关」的附录）。
   * 所以不能用「标题里出现过 T1」这种宽判断，要用「标题以 T1 开头」。
   */
  const isTopicSection = (s: string) => {
    const heading = (s.split("\n")[0] ?? "").replace(/^#+\s*/, "");
    return TOPICS.some((t) => heading.startsWith(t.id));
  };

  // cited：被**采信**的 id 并集，**只统计主题节里的**。
  //
  // ★ 为什么限定主题节（判据第 4 次修正）★
  // 实测：一份报告在末尾写了「## 附：与 T1–T5 无关的材料」，里面一条 bullet 说
  // 「M11、M21、M41 与五个主题均无关，不参与上述各节」，并带了一行「依据：M11、M21、M41」。
  // 旧判据只看「依据行」 → 把这份**正确处理了干扰项**的报告判成越界。
  // 语义上：「拿无关材料当依据」指的是把它当成某个主题的论据；
  // 在附录里声明「它们无关、已排除」是相反的（正确）行为。
  // 所以越界检查只看**主题节内部**的采信。
  const cited = new Set<string>();
  for (const s of sections) {
    if (!isTopicSection(s)) continue;
    for (const id of citedIds(s)) cited.add(id);
  }

  // ① 覆盖
  const missingTopics = TOPICS.filter((t) => !hasId(text, t.id)).map((t) => t.id);
  const covered = missingTopics.length === 0;
  if (!covered) failed.push(`没覆盖主题：${missingTopics.join(", ")}`);

  // ④ 编造 id
  const fabricated = [...allIds].filter((id) => !CORPUS_IDS.has(id));
  const idsValid = fabricated.length === 0;
  if (!idsValid) failed.push(`用了语料里不存在的编号：${fabricated.join(", ")}（编造）`);

  // ② 去重：**每一组**重复材料，组内 id 不许散在**多个条目**里
  //    （合并成一条 = 对；拆成两条 = 错。详见 entriesOf 的注释）
  const dedupDetail = DUPLICATE_GROUPS.map((group) => {
    const bad = sections.find((s) => {
      const entries = entriesOf(s);
      if (!entries.length) {
        // 没有列表项（报告不是条目式的）：退回按节判断
        const c = citedIds(s);
        return group.filter((id) => c.has(id)).length >= 2;
      }
      const hitEntries = entries.filter((e) => group.some((id) => hasId(e, id)));
      return hitEntries.length >= 2;
    });
    return { group, ok: bad === undefined };
  });
  const deduped = dedupDetail.every((d) => d.ok);
  for (const d of dedupDetail.filter((x) => !x.ok)) {
    failed.push(`重复没去干净：${d.group.join("、")} 散在多个条目里`);
  }

  // ③ 矛盾：**每一组**矛盾材料必须出现在同一节（成对写出来）
  const contradictionDetail = CONTRADICTION_GROUPS.map((group) => ({
    group,
    ok: sections.some((s) => group.every((id) => hasId(s, id))),
  }));
  const contradictionPaired = contradictionDetail.every((d) => d.ok);
  for (const d of contradictionDetail.filter((x) => !x.ok)) {
    failed.push(`矛盾没成对写出：${d.group.join(" 与 ")} 不在同一节`);
  }

  // 干扰：只在**采信名单**里算越界。
  const citedDistractors = DISTRACTORS.filter((d) => cited.has(d));
  const distractorClean = citedDistractors.length === 0;
  if (!distractorClean) failed.push(`把无关材料当了依据（越界）：${citedDistractors.join("、")}`);

  return {
    ok: covered && idsValid && deduped && contradictionPaired && distractorClean,
    covered,
    idsValid,
    deduped,
    contradictionPaired,
    distractorClean,
    dedupDetail,
    contradictionDetail,
    failed,
    reportHash: hash(text),
    reportChars,
  };
}

/** 计费口径：本实验里两边都是免费档，但仍如实记录 cost（换档位时这张表立刻有用） */
export function formatVerdict(v: Verdict): string {
  const tick = (b: boolean) => (b ? "✓" : "✗");
  return [
    `${tick(v.covered)} 覆盖`,
    `${tick(v.idsValid)} 无编造`,
    `${tick(v.deduped)} 去重`,
    `${tick(v.contradictionPaired)} 矛盾成对`,
    `${tick(v.distractorClean)} 无越界`,
  ].join("  ");
}
