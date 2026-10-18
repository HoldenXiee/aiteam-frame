// demox 的任务族：**可判分**的合成任务，每个自带 ground truth 与纯函数判据。
//
// 为什么不用 demom 的任务 T：
//   demom 的任务是「读 44 份材料写一份报告」，判据多达 5 项、跑一次 10–50 分钟。
//   demox 要做**大量重复扫描**（G0-2 扫参数、G0-3 测方差、G1-1 扫采样率…），
//   每次几十分钟的任务跑不起。所以这里全部换成**小、快、判据是纯函数**的任务。
//
// ★ 设计原则（全部来自 G0-1 的教训）★
//   1. **判据必须是纯函数**：输入产物（文本 + 结构化），输出 `Verdict`。可离线重判，不用重跑。
//   2. **ground truth 不泄露给 agent**：`hidden` 字段只给判据，不写进工作目录。
//   3. **结局要有区分度**：不能人人满分（demom 预跑 14 份材料就是这样废掉的）。
//   4. **正反结果都有价值**：每个任务都要能"做对"也能"做错"，错法上还要有结构。
//   5. **每个任务单列一个「难在哪」**：说明它在系统科学上测的是什么。

// ─────────────────────────────────────────────────────────────
// 0. 公共类型
// ─────────────────────────────────────────────────────────────

/** 每个任务的判据结果。**逐项**存，不只存一个 boolean —— 回看时要知道差在哪一项 */
export interface TaskVerdict {
  ok: boolean;
  /** 逐项明细（键是项名，值是过没过） */
  items: Record<string, boolean>;
  /** 未过的项，逐条人话 */
  failed: string[];
  /** 给分析用的连续读数（不是判据的一部分，但每次都要存） */
  readings: Record<string, number>;
}

export interface Doc {
  id: string;
  title: string;
  text: string;
}

/** 任务 = 语料 + 说明 + 判据（三项必须自洽，改一处要同步看另两处） */
export interface Task {
  id: string;
  /** 给 agent 的任务说明（所有实验组一字不差用这一份） */
  brief: string;
  /** 语料（**按需要多少份给多少份**，让扫描器能扫「材料数」这个参数） */
  corpus: Doc[];
  /** 判据用的 ground truth（**绝不写进工作目录**） */
  hidden: Record<string, unknown>;
  /** 产物文件名 */
  artifact: string;
  /** 判据：纯函数。文本产物 + 结构化产物 → 结果 */
  judge: (text: string | null, structured: unknown) => TaskVerdict;
  /** 这个任务在系统科学上测什么（一句话） */
  measures: string;
  /** 难在哪（说明它为什么有区分度） */
  difficulty: string;
}

// ─────────────────────────────────────────────────────────────
// T-A · 找重复组（快，判据极硬）—— G0-3 方差基线 / G1-1 反馈相图 / G6 分岔 用
// ─────────────────────────────────────────────────────────────

/**
 * 语料：N 份短材料，其中若干对讲**同一件事**（说法不同），若干份是干扰。
 * 任务：找出所有重复组，输出 JSON。
 *
 * 为什么这个任务适合扫描：
 *   · 判据是**集合比较**，无歧义、无主观；
 *   · 难度可由「材料数」和「重复组的隐晦程度」两个旋钮调；
 *   · 它正是 demom 里唯一真正拉开差距的那一项（去重），所以结论可与 demom 对接。
 */
const TOPIC_POOL: [string, string][] = [
  // [共同论点, 换一种说法]
  ["逐轮裁剪比整段压缩便宜，因为前者不改历史", "同一个取舍换个说法：不动历史的那种做法成本更低"],
  ["工具白名单设太宽会让完成率下降", "把允许的工具从 3 个放到 6 个，完成率反而从 80% 掉到 55%"],
  ["审批门设太严会拦掉正确调用，反而拖慢任务", "过度保守的门是伪安全，拦的是自己的效率"],
  ["技能是软约束，删掉它脚本照样能跑", "SKILL.md 靠模型自觉遵守，不构成任何保证"],
  ["上下文共享比文件交接便宜，因为它消灭了重复读", "把上游看过的直接给下游，总成本反而降了"],
  ["子 agent 应该是只读的，写权集中在一个人手里", "并行写会让各自的隐含假设互相冲突"],
  ["护栏的阈值必须从实测分布里取，不能拍脑袋", "凭直觉设的上限会把自己的正常干活掐死"],
  ["判断质量受限于该判断点能看到多少信息", "眼睛被蒙上的人做不了全局判断"],
  // ── 下面这批是后来补的：只有 8 个话题时 `pairs` 最多只能扫到 8，
  //    再往上就会重复使用同一个话题，造出**假重复**（语料里出现 4 份讲同一件事，
  //    而判据仍只要求 2 份一组 → 语料与判据不自洽）。扩到 16 个之后可扫到 pairs=16。
  ["结构化交接面是代码强制保真的前提", "想让代码接住判断，得先让判断落成数据而不是自然语言"],
  // ⚠️ 2026-10-16 深夜修正：这里原来有一条 ["轨迹共享比让下游重读原文更便宜", "把上游的上下文直接注进去，下游就不用再读一遍"]
  //   它和上面的「上下文共享比文件交接便宜…」**是同一个观点** —— 造出了**假重复**：
  //   语料里有 4 份讲同一件事，而判据只要 2 份一组 ⇒ ★ 模型把 M5/M6/M23/M24 并成一组是**正确**的，
  //   却被判成「过度合并」。P7/N2/P9/F-5 里那个反复出现的错误签名都指向它。**换成不撞车的观点。**
  ["给模型的示例越多，它照抄示例里细节的倾向越强", "演示了三行的写法，它就只会写三行"],
  ["流程的错误更局部、更好定位", "固定阶段的失败能指到一个坐标上，自由集群的失败是弥散的"],
  ["集群的失败有界，流程的失败无界", "捆绑了阶段数让人以为不会失控，但阶段内部可以失控"],
  ["能力给了模型也不会自己用", "把双向通信工具挂上去，一次都没被调用过"],
  ["重复读不是浪费，是信息传递本身", "没有别的传递渠道时，重读就是传递"],
  ["护栏要按阶段设，不能用一个全局值", "每个位置该有多重，只有设计者知道"],
  ["委派的收益取决于子任务能不能真的分解", "分不开的任务上，多派一个人只是多一份协调开销"],
];

/** 话题池容量 —— `pairs` 的上限。超过它就会重复使用话题，造出假重复 */
export const MAX_PAIRS = TOPIC_POOL.length;

const DISTRACTOR_TEXTS = [
  "（与本任务无关的旁枝笔记）上次的机器宕机是因为磁盘写满，和 agent 设计没有关系。",
  "（与本任务无关的旁枝笔记）会议室预订系统换了个新版本，界面颜色变了。",
  "（与本任务无关的旁枝笔记）咖啡机的滤芯该换了的提醒，请忽略。",
  "（与本任务无关的旁枝笔记）这份文档的排版字体用了旧版模板。",
];

/** 造语料：`pairs` 个重复组 + `distractors` 份干扰；材料的编号是 M1..Mn（**顺序打乱**） */
export function buildDupTask(pairs: number, distractors: number, seed = 1): Task {
  if (pairs > MAX_PAIRS) {
    throw new Error(
      `pairs=${pairs} 超过话题池容量 ${MAX_PAIRS} —— 再往上会重复使用话题，造出假重复` +
        `（语料里有 4 份讲同一件事，而判据只要求 2 份一组 → 语料与判据不自洽）`,
    );
  }
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(arr: T[], taken: Set<number>): T => {
    for (;;) {
      const i = Math.floor(rnd() * arr.length);
      if (!taken.has(i)) {
        taken.add(i);
        return arr[i];
      }
    }
  };

  const taken = new Set<number>();
  const groups: string[][] = [];
  const docs: Doc[] = [];
  let n = 0;
  const mk = (title: string, text: string): Doc => {
    n += 1;
    return { id: `M${n}`, title, text };
  };

  for (let g = 0; g < pairs; g++) {
    const [a, b] = pick(TOPIC_POOL, taken);
    const idA = mk(`笔记 ${g + 1}a`, a);
    const idB = mk(`笔记 ${g + 1}b`, b);
    docs.push(idA, idB);
    groups.push([idA.id, idB.id]);
  }
  const dis: string[] = [];
  for (let d = 0; d < distractors; d++) {
    const t = DISTRACTOR_TEXTS[d % DISTRACTOR_TEXTS.length];
    const doc = mk(`杂记 ${d + 1}`, t);
    docs.push(doc);
    dis.push(doc.id);
  }

  // 打乱顺序（编号已经定了，打乱的是**出现顺序** —— 这是 G4-3「涨落」的一个天然旋钮）
  for (let i = docs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [docs[i], docs[j]] = [docs[j], docs[i]];
  }

  const allIds = docs.map((d) => d.id);

  return {
    id: "T-A",
    brief: [
      `工作目录的 corpus/ 里有 ${docs.length} 份笔记，每份有唯一编号（M1、M2…）。`,
      "",
      "其中有些笔记在**讲同一件事**（措辞不同，要读懂才知道是同一件）；也有几份与本任务无关。",
      "",
      `请把结果写成 ${"answer.json"}，格式：`,
      '{"duplicates": [["M3", "M7"], ["M12", "M31"]], "irrelevant": ["M11"]}',
      "",
      "· duplicates：**每一组讲同一件事的编号**，按数组列出。两个编号顺序无所谓。",
      "· irrelevant：与其它笔记主题都无关的那些编号。",
      "· 只许用 corpus/ 里真实存在的编号。",
      "· 除 JSON 外不要写别的文件。",
    ].join("\n"),
    corpus: docs,
    hidden: { groups, distractors: dis, allIds },
    artifact: "answer.json",
    judge: judgeDup(groups, dis, allIds),
    measures: "跨材料综合 —— 需要有人同时看见多份才能判「是不是同一件事」",
    difficulty: "重复组靠语义而不是字面匹配；干扰项与重复组的区分要靠主题判断",
  };
}

/** 判据：集合比较。`ok` 要求**全对**（重复组全中找到、且没有假组；干扰项全找到、且没有假干扰） */
function judgeDup(groups: string[][], distractors: string[], allIds: string[]) {
  return (text: string | null, structured: unknown): TaskVerdict => {
    const failed: string[] = [];
    const items: Record<string, boolean> = {};
    const readings: Record<string, number> = {
      answerChars: text ? text.length : 0,
      groupsFound: 0,
      groupsFalse: 0,
      distractorsFound: 0,
      distractorsFalse: 0,
      idsFabricated: 0,
    };

    const parsed = parseAnswer(text, structured);
    if (!parsed) {
      return {
        ok: false,
        items: { produced: false },
        failed: ["产物不存在或不是合法 JSON"],
        readings,
      };
    }
    items.produced = true;

    const norm = (g: string[]) => g.map((x) => x.toUpperCase()).sort().join("≡");
    const want = new Set(groups.map(norm));
    const got = new Set((parsed.duplicates ?? []).map(norm));

    readings.groupsFound = [...want].filter((w) => got.has(w)).length;
    readings.groupsFalse = [...got].filter((g) => !want.has(g)).length;
    items.groupsExact = readings.groupsFound === want.size && readings.groupsFalse === 0;
    if (!items.groupsExact) {
      const missing = [...want].filter((w) => !got.has(w));
      const extra = [...got].filter((g) => !want.has(g));
      if (missing.length) failed.push(`漏掉的重复组：${missing.join(" / ")}`);
      if (extra.length) failed.push(`多报的重复组（不是同一件事）：${extra.join(" / ")}`);
    }

    // 干扰项：只要**没把干扰项列进任何重复组**就算过（不要求它主动报告 irrelevant ——
    // 那是加分的严格项，会人为压低通过率，与 demom §3 第 1 条的教训同类）
    const inGroups = new Set((parsed.duplicates ?? []).flat().map((x) => x.toUpperCase()));
    const usedDistractor = distractors.filter((d) => inGroups.has(d));
    readings.distractorsFalse = usedDistractor.length;
    items.distractorsClean = usedDistractor.length === 0;
    if (!items.distractorsClean) failed.push(`把无关材料当成了同一件事：${usedDistractor.join("、")}`);

    // 编造编号
    const all = new Set(allIds);
    const cited = new Set([...(parsed.duplicates ?? []).flat(), ...(parsed.irrelevant ?? [])].map((x) => String(x).toUpperCase()));
    const fabricated = [...cited].filter((x) => !all.has(x));
    readings.idsFabricated = fabricated.length;
    items.idsValid = fabricated.length === 0;
    if (!items.idsValid) failed.push(`用了不存在的编号：${fabricated.join("、")}`);

    readings.groupsTotal = want.size;
    items.allGroups = readings.groupsFound === want.size;

    return {
      ok: Object.values(items).every(Boolean),
      items,
      failed,
      readings,
    };
  };
}

/** 从文本或结构化产物里抠出答案（容错：允许 ```json 包裹、允许前后有解释） */
export function parseAnswer(text: string | null, structured: unknown): { duplicates?: string[][]; irrelevant?: string[] } | null {
  if (structured && typeof structured === "object") {
    const o = structured as Record<string, unknown>;
    if (Array.isArray(o.duplicates)) return { duplicates: o.duplicates as string[][], irrelevant: (o.irrelevant as string[]) ?? [] };
  }
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fence?.[1], text].filter(Boolean) as string[];
  for (const c of candidates) {
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const o = JSON.parse(c.slice(start, end + 1)) as Record<string, unknown>;
      if (Array.isArray(o.duplicates)) {
        return {
          duplicates: (o.duplicates as unknown[][]).map((g) => g.map((x) => String(x))),
          irrelevant: Array.isArray(o.irrelevant) ? (o.irrelevant as unknown[]).map(String) : [],
        };
      }
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 注册表：按 id 取任务（扫描器用）
// ─────────────────────────────────────────────────────────────

export const TASKS: Record<string, () => Task> = {
  "T-A": () => buildDupTask(4, 2, 1),
};

export function getTask(id: string): Task {
  const f = TASKS[id];
  if (!f) throw new Error(`未知任务：${id}（有：${Object.keys(TASKS).join(", ")}）`);
  return f();
}
