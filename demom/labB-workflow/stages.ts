// 实验室 B：固定流程 —— 阶段定义 + 边（这张图跑之前就画得出来）。
//
// ★ 与 A 的对照 ★：A 的图是运行时长的，B 的图是下面这张写死的常量表。
// 每个节点 = 一个 agent（固定角色 + 固定工具集），每条边 = 谁的结果传给谁。
// runner.ts 按拓扑序驱动，**没有一步是模型决定的**。

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readdirSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "../env.ts";
import { DRAFT_DIR, REPORT_FILE, hasId } from "../bench/task.ts";

/** 一个阶段 = 一个 agent 的位置 */
export interface Stage {
  id: string;
  /** agent 的 role（与 A 的花名册角色**同等详细** —— 公平性自查表第 4 条） */
  role: string;
  /** 工具白名单：**精确就是这些** */
  tools: string[];
  /** 依赖的阶段 id（拓扑序）。空数组 = 起手就能跑 */
  needs: string[];
  /** 起手就交给它的活（模板；中间不插模型决策） */
  task: string;
  /** 它能用的自定义工具名（从 STAGE_TOOLS 里挑） */
  custom: string[];
  /**
   * "agent"（默认）= 起一个 agent 干活；"code" = **纯代码步骤**，不起 agent。
   *
   * ★ 这是 B 相对 A 的**结构性优势**，不是调参 ★
   * 固定流程允许设计者在**已知的位置**插一个确定性步骤。
   * 集群里没有这个位置 —— 它每一步都由模型决定，所以只能「请模型记得做对」。
   */
  kind?: "agent" | "code";
  /** kind === "code" 时执行；返回一行给日志的说明 */
  run?: () => string;
  /**
   * 这个阶段的工具调用上限（防失控）。
   *
   * ★ 为什么按**阶段**而不是一个全局值 ★
   * 实测的调用数分布：正常阶段 3–99 次，失控的两次是 119 / 135 / 423 次 ——
   * 分不开（99 和 119 差不多）。**但按阶段就能分开**，因为设计者知道每个阶段该有多重：
   * S1 要读 ~44 份材料（60 合理），S5 只是校一份报告（30 就够）。
   * 这正是固定流程能干、集群干不了的事：**每个位置的上限由设计者写死**。
   */
  maxCalls?: number;
}

// ─────────────────────────────────────────────────────────────
// 中间产物：与 A **同一条规矩**（走文件），不是内存传值
// ─────────────────────────────────────────────────────────────
function draftPath(who: string): string {
  return join(cwd, DRAFT_DIR, `${who}.md`);
}

/**
 * 追加片段（所有需要留痕的阶段共用）。
 *
 * ⚠️ 是**工厂**：每个阶段拿一个绑好自己名字的实例（note 写进 draft/<阶段名>.md）。
 * 不用从 ctx 里猜阶段名 —— pi 的 ToolContext 没有这种东西，猜就是编 API。
 */
export function noteToolFor(who: string) {
  return defineTool({
    name: "note",
    label: "Note",
    description: `把一段结论追加记进你的中间产物文件 draft/${who}.md。交给下游的成果必须用这个工具落下来。`,
    parameters: Type.Object({ text: Type.String({ description: "要记下的内容（Markdown）" }) }),
    execute: async (_id, p) => {
      mkdirSync(join(cwd, DRAFT_DIR), { recursive: true });
      appendFileSync(draftPath(who), `\n## [${who}]\n${p.text}\n`, "utf8");
      return { content: [{ type: "text" as const, text: `已追加进 draft/${who}.md` }], details: {} };
    },
  });
}

/** 读全部材料 */
export const listCorpusTool = defineTool({
  name: "list_corpus",
  label: "List Corpus",
  description: "列出 corpus/ 目录里的全部材料编号与标题。",
  parameters: Type.Object({}),
  execute: async () => {
    const names = readdirSync(join(cwd, "corpus")).filter((f) => f.endsWith(".md"));
    return { content: [{ type: "text" as const, text: names.join("\n") }], details: { count: names.length } };
  },
});

/**
 * ★ 结构化交接工具（只给 S2 用）★
 *
 * 为什么需要它：S2 的结论现在只活在**自由文本**里（“M12 与 M31…合并”），
 * 下游只能靠“读得懂”来接。把分组落成 **JSON** 后，下游可以用代码消费它，
 * 而不是再赌一次模型的理解力。
 *
 * 文献对应：Anthropic 的 **artifact systems** —— “子 agent 写进持久存储，
 * 只回传轻量引用，防止多阶段处理中的信息丢失”。
 */
export const GROUPS_FILE = "S2-groups.json";

export function recordGroupsTool() {
  return defineTool({
    name: "record_groups",
    label: "Record Groups",
    description:
      "把「同一件事」的重复材料分组，以结构化形式落进 draft/S2-groups.json。" +
      "这是给下游**强制合并**用的数据，请务必调用（格式由参数约束）。",
    parameters: Type.Object({
      groups: Type.Array(
        Type.Object({
          ids: Type.Array(Type.String({ description: "这一组包含的材料编号，如 [\"M12\",\"M31\"]" })),
          topic: Type.String({ description: "属于哪个主题，如 T5" }),
          fact: Type.String({ description: "这一组讲的那件事，一句话" }),
        }),
      ),
    }),
    execute: async (_id, p) => {
      mkdirSync(join(cwd, DRAFT_DIR), { recursive: true });
      writeFileSync(join(cwd, DRAFT_DIR, GROUPS_FILE), JSON.stringify(p.groups, null, 2), "utf8");
      return {
        content: [{ type: "text" as const, text: `已记录 ${p.groups.length} 组重复材料到 draft/${GROUPS_FILE}` }],
        details: { count: p.groups.length },
      };
    },
  });
}

/** 读中间产物（S4 成文阶段用） */
export const readDraftsTool = defineTool({
  name: "read_drafts",
  label: "Read Drafts",
  description: "读中间产物目录 draft/ 里的全部片段。",
  parameters: Type.Object({}),
  execute: async () => {
    const dir = join(cwd, DRAFT_DIR);
    let body: string;
    try {
      body = readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => `\n===== ${f} =====\n${readFileSync(join(dir, f), "utf8")}`)
        .join("\n");
    } catch {
      body = "（draft/ 里什么都没有）";
    }
    return { content: [{ type: "text" as const, text: body }], details: {} };
  },
});

export function toolByName(name: string, stage: string) {
  switch (name) {
    case "note":
      return noteToolFor(stage);
    case "list_corpus":
      return listCorpusTool;
    case "read_drafts":
      return readDraftsTool;
    case "record_groups":
      return recordGroupsTool();
    default:
      throw new Error(`阶段 ${stage} 声明了不存在的工具：${name}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 这张图（B 的全部设计内容）
// ─────────────────────────────────────────────────────────────
export const STAGES: Stage[] = [
  {
    id: "S1-摸底",
    role:
      "索引员：读 corpus/ 里的全部材料，产出一份清单，写清三件事——哪几份在讲同一件事（重复候选）、哪几份对同一件事给出相反结论（矛盾候选）、哪几份与 T1–T5 五个主题都无关。你只摸底，不写报告。",
    tools: ["read", "note", "list_corpus"],
    needs: [],
    custom: ["note", "list_corpus"],
    maxCalls: 60,
    task:
      "读 corpus/ 里的全部材料，用 note 工具记下三件事：① 重复候选（哪几份讲同一件事）；" +
      "② 矛盾候选（哪几份对同一件事结论相反）；③ 与 T1–T5 五个主题都无关的材料。",
  },
  {
    id: "S2-去重",
    role:
      "去重员：拿上游的重复候选清单，逐组判定「是不是同一件事」。是同一件就合并成一条依据，标出所有相关编号。",
    tools: ["read", "note"],
    needs: ["S1-摸底"],
    custom: ["note"],
    maxCalls: 60,
    task: "读 draft/S1-摸底.md，把里面的重复候选逐组判定：确认是同一件事的，合并成一条依据（列出所有相关编号）；不是的，说明为什么。用 note 记下来。",
  },
  {
    id: "S3-查矛盾",
    role:
      "对账员：拿上游的矛盾候选清单，逐组核对原文，写成「M5 说 X，M9 说不 X」这样成对的表述。",
    tools: ["read", "note"],
    needs: ["S1-摸底"],
    custom: ["note"],
    maxCalls: 60,
    task: "读 draft/S1-摸底.md，把里面的矛盾候选逐组核对原文，写成成对的表述（形如「M5 说 X，M9 说不 X」）。用 note 记下来。",
  },
  {
    id: "S4-成文",
    role:
      "写手：读 draft/ 里的全部片段，按 T1–T5 分节拼成 report.md。每节标题以「## 」开头，节末单独一行写依据编号。你是本流程里**唯一**能落盘的人。",
    tools: ["read", "write", "note", "read_drafts"],
    needs: ["S2-去重", "S3-查矛盾"],
    custom: ["note", "read_drafts"],
    maxCalls: 70,
    task:
      "读 draft/ 里的全部片段，按 T1–T5 分节写出 report.md。每条依据标出材料编号（如「依据：M1」），" +
      "不许使用 corpus/ 里不存在的编号。重复的只写一条，矛盾的要成对写明。",
  },
  {
    id: "S5-校验",
    role:
      "校验员：逐条核 report.md —— 编号是不是编的、重复有没有漏、矛盾有没有成对。你**只读不改**，发现问题就报告，不要自己动手改。",
    tools: ["read"],
    needs: ["S4-成文"],
    custom: [],
    maxCalls: 30,
    task: "读 report.md，逐条核：① 有没有 corpus/ 里不存在的编号；② 重复有没有漏；③ 矛盾有没有成对。把核查结果写出来（你不需要用工具写文件，直接回答）。",
  },
];

/**
 * ★ 纯代码阶段：强制合并 ★
 *
 * 解决的问题（实测出来的）：S2 已经判定「M12 与 M31 是同一件事」，
 * 但 S4 成文时把同组材料拆成两条 bullet —— 上游对的结论在 handoff 处失真。
 * 文献里这叫 **Signal Corruption / Referential Drift**（AgentAsk 的 edge-level 分类）。
 *
 * 上一个变体（preserve）试图用**指令**让 S4 别拆：有效但不可靠（n=3 时 2/3），
 * 因为「模型是否遵守」本身就是一个变量。
 *
 * 这个阶段换成**确定性做法**：读 S2 落下的结构化分组 draft/S2-groups.json，
 * 直接改 report.md —— 把散在多个 bullet 里的同组材料**机械地合并成一条**。
 * 不依赖模型遵守，所以**不会失败**。
 *
 * ⚠️ 边界要说清楚：它**不判断**「哪些材料是重复的」（那是 S2 的模型判断，是任务难点），
 *    它只保证「已经判定为重复的，在产物里确实合并了」。分工是：
 *    **模型负责判断，代码负责保真。**
 */
export function enforceGroups(): string {
  const groupsPath = join(cwd, DRAFT_DIR, GROUPS_FILE);
  const reportPath = join(cwd, REPORT_FILE);
  if (!existsSync(groupsPath)) return `跳过：S2 没落下 draft/${GROUPS_FILE}`;
  if (!existsSync(reportPath)) return `跳过：还没有 ${REPORT_FILE}`;

  let groups: { ids?: unknown }[];
  try {
    groups = JSON.parse(readFileSync(groupsPath, "utf8"));
  } catch (e) {
    return `跳过：${GROUPS_FILE} 不是合法 JSON（${(e as Error).message}）`;
  }
  if (!Array.isArray(groups)) return `跳过：${GROUPS_FILE} 不是数组`;

  const lines: (string | null)[] = readFileSync(reportPath, "utf8").split("\n");
  const isEntry = (l: string) => /^\s*([-*]|\d+[.、)])\s+/.test(l);
  const idsIn = (s: string) => [...new Set((s.match(/\bM\d+\b/g) ?? []).map((x) => x.toUpperCase()))];
  /** 去掉条目末尾的「（M12、M31）」引用括号 */
  const stripCite = (s: string) => s.replace(/[（(][^（()）]*[）)]\s*$/, "").trimEnd();
  const bulletPrefix = (s: string) => (s.match(/^\s*([-*]|\d+[.、)])\s+/) ?? ["- "])[0];

  // 行 → 节号（判据是**按节**查重复的，所以合并也必须在节内做，不能跳节合并）
  const sectionOf: number[] = [];
  let sec = -1;
  for (const l of lines) {
    if (/^##\s/.test(l)) sec++;
    sectionOf.push(sec);
  }

  let mergedGroups = 0;
  const details: string[] = [];
  for (const g of groups) {
    const ids = (Array.isArray(g.ids) ? g.ids : []).map((s) => String(s).toUpperCase());
    if (ids.length < 2) continue;

    const hits = lines
      .map((l, i) => ({ l, i }))
      .filter((h): h is { l: string; i: number } => h.l !== null && isEntry(h.l) && ids.some((id) => hasId(h.l, id)));

    // 按节分组命中，逐节合并（同一组散在同一节的 ≥2 条才算违规）
    const bySection = new Map<number, { l: string; i: number }[]>();
    for (const h of hits) {
      const k = sectionOf[h.i];
      if (!bySection.has(k)) bySection.set(k, []);
      bySection.get(k)!.push(h);
    }

    for (const [, group] of bySection) {
      if (group.length < 2) continue;
      // 合并：各条去掉引用括号后的文字拼起来（去重），引用取并集
      const union = [...new Set(group.flatMap(({ l }) => idsIn(l)))];
      const parts: string[] = [];
      for (const { l } of group) {
        const t = stripCite(l).replace(/^\s*([-*]|\d+[.、)])\s+/, "").trim();
        if (t && !parts.includes(t)) parts.push(t);
      }
      lines[group[0].i] = `${bulletPrefix(group[0].l)}${parts.join("；")}（${union.join("、")}）`;
      for (const { i } of group.slice(1)) lines[i] = null;
      mergedGroups++;
      details.push(`${ids.join("、")} 的 ${group.length} 条合为 1 条`);
    }
  }

  if (!mergedGroups) return "无需强制合并：没有发现散开的重复组";
  writeFileSync(reportPath, lines.filter((l) => l !== null).join("\n"), "utf8");
  return `强制合并 ${mergedGroups} 处散开的重复材料（${details.join("；")}）`;
}

/** 拓扑序：把 STAGES 排成可执行的批次（同批次 = 可并行） */
export function topoBatches(stages: Stage[] = STAGES): Stage[][] {
  const done = new Set<string>();
  const batches: Stage[][] = [];
  let rest = [...stages];
  while (rest.length) {
    const ready = rest.filter((s) => s.needs.every((n) => done.has(n)));
    if (!ready.length) throw new Error(`阶段图有环，排不出拓扑序：${rest.map((s) => s.id).join(", ")}`);
    batches.push(ready);
    for (const s of ready) done.add(s.id);
    rest = rest.filter((s) => !done.has(s.id));
  }
  return batches;
}

/**
 * 变体：一次只改一件事。
 *
 *   base      —— 原版
 *   preserve  —— ★ 改进假设（针对实测发现的失败）★
 *
 * 背景：实测发现 B 的 S2-去重 **做对了**（“M12 与 M31…同一主题，合并。依据：M12、M31”），
 * 但 S4-成文 把每份材料又展开成一条独立的 bullet，**把上游的合并决定弄丢了**。
 * 报告里 27/31 个条目都是“- M数字：…”这种逐份列举 —— 结构上就不可能体现合并。
 *
 * 这在文献里叫 **Signal Corruption / Referential Drift**（AgentAsk 的 edge-level 错误分类）：
 * 上游对的结论在 handoff 处失真。所以这个变体只改一件事：
 * **明确要求 S4 保留 S2 的合并分组，不许把同组合并的材料拆成多条。**
 *
 * 它检验的问题是：B 的失败是**结构性的**（固定流程天生会丢信息），
 * 还是**局部的**（只是 S4 的指令没说清）？
 */
export function stagesFor(variant: string): Stage[] {
  if (variant === "mechanical") return MECHANICAL;
  // share / steer 用与 verify **同一张图** —— 差别不在图上，在 runner 的交接/护栏机制
  if (variant === "verify" || variant === "share" || variant === "steer") return VERIFY;
  if (variant === "board") return BOARD;
  if (variant !== "preserve") return STAGES;
  return STAGES.map((s) => (s.id === "S4-成文" ? { ...s, task: s.task + PRESERVE_INSTRUCTION } : s));
}

/**
 * ★ board 变体：把「交接」换成一块**共享工作台** ★
 *
 * 这是从本实验的全部分析里长出来的一个**构件**（`bench/workbench.ts`），不是某个功能的用法示例。
 * 它同时针对两个实测结论：
 *   · 交接必须有全局视野 + 无损（否则 A/nodup 与 B/base 同一种失败）
 *   · 但轨迹共享很贵（B/share 注入 ~100k 字符，B/verify 重读 45 份 = 1004k token）
 *
 * 做法：每个阶段多一个 `post` 工具，把结论写成**结构化条目**进共享黑板；
 * 黑板每轮注入**每一个** agent；代码在写入时校验不变量、并在消化后把原文移出上下文。
 *
 * 与 verify 的差别：**下游不必重读原文** —— S2 直接在黑板上看到 S1 记下的要点。
 * 与 share 的差别：**注入的是提炼过的结论，不是原始轨迹** —— 所以便宜。
 */
const PRESERVE_INSTRUCTION =
  "\n\n★ 重要（合并保真）★：draft/S2-去重.md 已经判定好了哪些材料是同一件事、合并成哪几组。" +
  "你在报告里**必须保留那个分组**：同一组里的材料只能出现在**同一条 bullet** 里（例如「（M12、M31）」），" +
  "**绝对不要**把同一组的材料拆成两条或多条 bullet 分别列举。\n" +
  "换句话说：**不要写「- M3：…」「- M7：…」这种逐份列举**，那会把已经合并好的东西又拆开。" +
  "每条 bullet = 一个事实，bullet 末尾用括号标出它引用的**全部**编号。";

/**
 * ★ mechanical 变体：把「保真」从提示词里拿出来，交给代码 ★
 *
 * 与 preserve 的差别只有两处（其余阶段一字不改）：
 *   1. S2 多一个 `record_groups` 工具，把分组落成**结构化 JSON**（而不只是自由文本）；
 *   2. S4 之后多一个 **纯代码阶段 S6-强制合并**，直接改 report.md 把散开的组并回去。
 *
 * 它检验的问题是：
 *   **流程的“结构性优势”到底是不是真的？**
 *   —— 固定流程允许在**已知位置**插确定性步骤；如果这招有效，
 *      那就说明 B 之前的失败是**设计缺陷**（该写代码的地方写了提示词），
 *      而不是“固定流程天生不如集群”。
 */
const MECHANICAL: Stage[] = STAGES.map((s) => {
  if (s.id === "S2-去重") {
    return {
      ...s,
      tools: ["read", "note", "record_groups"],
      custom: ["note", "record_groups"],
      task:
        s.task +
        `\n\n另外：判定完以后，**必须**调用 record_groups 工具，把你确认的每一组重复材料落成结构化数据` +
        `（每组：ids 数组 + 所属主题 + 一句话事实）。下游会**用代码**消费这份数据，所以格式比文采重要。`,
    };
  }
  if (s.id === "S4-成文") {
    return { ...s, task: s.task + PRESERVE_INSTRUCTION };
  }
  if (s.id === "S5-校验") {
    // 校验必须在**强制合并之后**，否则它校的是过期产物
    return { ...s, needs: ["S6-强制合并"] };
  }
  return s;
});

// S6 插在 S4 与 S5 之间（纯代码，不起 agent）
MECHANICAL.splice(MECHANICAL.findIndex((s) => s.id === "S5-校验"), 0, {
  id: "S6-强制合并",
  role: "（代码步骤，不是 agent）",
  tools: [],
  needs: ["S4-成文"],
  custom: [],
  kind: "code",
  run: enforceGroups,
  task: "",
});

/**
 * ★ verify 变体：给「做去重判断的人」全局视野 ★
 *
 * 实测发现的瓶颈（mechanical 第一次真跑）：
 *   强制合并**成功了**（代码阶段跑了，把 S2 给的组并了回去），
 *   但报告还是挂 —— 因为 **S2 给的分组本身就错了**：
 *   S2 写的是「M1、M7 是同一件事」，而真值是「M3、M7」。
 *   而 S2 自己交代了原因：「原始材料 M1–M44 不在可访问路径，判定依据为 S1-摸底」。
 *
 * 查下来是个**设计缺口**：S2 的工具是 [read, note]，而语料文件名是 `M3-压缩不如裁剪省.md`
 * —— 它既没有 `list_corpus` 去看文件名，任务也没叫它读原文。
 * **它只能看着 S1 的摘要做判定。**
 *
 * 这与 A 的 nodup 实验是**同一个教训**（研究记录 §2）：
 *   把做全局判断的那个人的眼睛蒙上，它就做不了全局判断。
 *   A 里是拿掉 root 的 read（ok 4/6 → 0/2），B 里是让 S2 只能看摘要。
 *
 * 所以这个变体只改一件事：
 *   **S2 拿到 list_corpus + read，被明确要求拿原始材料逐组核对，
 *   发现 S1 的候选错了就改，漏了就以原文为准补上。**
 *
 * 它检验的问题是：B 剩下的失败，到底是「固定流程天生不行」，
 * 还是「该给视野的地方没给视野」？
 */
const VERIFY: Stage[] = MECHANICAL.map((s) => {
  if (s.id === "S3-查矛盾") {
    // ★ S3 也有同一个缺口（实测：它只有 read，找不到语料文件名，
    //   于是反复盲试读了 81 次、一个字没写下来）★
    return {
      ...s,
      tools: ["read", "note", "list_corpus"],
      custom: ["note", "list_corpus"],
      task:
        s.task +
        "\n\n⚠️ 核对必须拿**原文**（用 list_corpus 看文件名，再用 read 读 corpus/ 里的材料），" +
        "不要只看 S1 的摘要 —— S1 的候选可能配错对。核对完用 note 记下结论。",
    };
  }
  if (s.id !== "S2-去重") return s;
  return {
    ...s,
    tools: ["read", "note", "list_corpus", "record_groups"],
    custom: ["note", "list_corpus", "record_groups"],
    task:
      "读 draft/S1-摸底.md 拿到「重复候选」清单。\n\n" +
      "⚠️ 但是：**S1 的候选可能有错**（配错对、漏掉组）—— 它只是第一道粗筛。\n" +
      "你必须**用 list_corpus 列出 corpus/ 里的文件，再用 read 读原始材料，逐组核对**，\n" +
      "而不是只看 S1 的摘要。核对后：\n" +
      "  · S1 配错了 → 改成正确的组；\n" +
      "  · S1 漏了 → 以原文为准补上；\n" +
      "  · 两个材料只是「沾边」而不是「讲同一件事」→ 不算重复。\n\n" +
      "判定完用 note 记下结论（含理由），并调用 record_groups 把最终分组落成结构化数据。",
  };
});


const BOARD: Stage[] = VERIFY.map((s) => {
  if (s.kind === "code") return s;
  const base = { ...s, tools: [...s.tools, "post"], custom: [...s.custom, "post"] };
  // S1 的活就是读全部材料（它不读就没人读）—— 其余阶段**从黑板上拿**，不重读
  if (s.id === "S1-摸底") {
    return {
      ...base,
      task:
        s.task +
        "\n\n★ 共享工作台 ★：你读过的每一份材料，**用 post（kind=note）把一句话要点写进去**" +
        "（ids=[那份的编号]，text=要点）—— 写完那份原文就会被移出你的上下文腾地方。" +
        "另外把你判定的重复候选用 post（kind=dup）写进去。" +
        "下游阶段**只能看到你写进黑板的东西**，所以要点要写得足够让它们做判断。",
    };
  }
  if (s.id === "S2-去重" || s.id === "S3-查矛盾") {
    return {
      ...base,
      task:
        s.task +
        "\n\n★ 共享工作台 ★：S1 已经把每份材料的**要点**写进黑板了（你每轮都能看到）。" +
        "**先用黑板上的要点做判断，不要重读一遍全部材料** —— 只有当某两条要点看起来矛盾、" +
        "你无法从要点判断时，才去 read 那几份原文核对。" +
        "判定完用 post 写进黑板（kind=dup / kind=contradiction）。",
    };
  }
  if (s.id === "S4-成文") {
    return {
      ...base,
      task:
        s.task +
        "\n\n★ 共享工作台 ★：黑板上有全部材料要点、已判定的重复组、已判定的矛盾对。" +
        "**直接根据黑板写报告**（重复组只能写成一条、矛盾对必须成对）。" +
        "如果黑板信息不够，可以 read 那几份原文补，但不要盲目重读。",
    };
  }
  return base;
});

/** preserve 变体给 S4 追加的那段指令（mechanical 也复用） */
