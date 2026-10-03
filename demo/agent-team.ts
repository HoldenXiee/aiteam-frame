// demo/agent-team.ts —— 完整例子：多 agent 分工协作，产出一份真报告（产物落在 demo/work/）。
//
// 跑法：PI_OFFLINE=1 node demo/agent-team.ts        产物：demo/work/report.md
//      （PI_OFFLINE 加不加都行：离线由 demo/env.ts 钉死，见那里的注释。）
//
// 它是什么：**一个可改造的起点，不是推荐架构**。「几个 agent、怎么分工、要不要护栏、门拦什么」
// 全部是下面这些使用者代码 —— 库里没有一条这样的政策。每一处设计决策旁边都有一行
// 「要检验这条，改成 X 再跑」：那是实验入口，不是装饰，改法都具体可执行。
//
// 假 provider 是**按脚本回话**的（见 examples/lib/faux-server.ts 顶部）：提示里的 `[[tool:…]]` /
// `[[call:…]]` 是给它的指令，它自己只会回 `echo:<原文截断>`，不会写字。所以：
//   - 报告里的**每一句话都由本文件的代码拼出**（`writeReport()`：黑板 + 语料）；
//   - 「模型」在这里负责的是**调用顺序与取舍**（查什么、采信哪几条、报告分几节），它们经工具参数
//     落进黑板，再由代码兑现成文 —— 所以下面那些「取舍」是脚本转录的，不是模型判断的。
//     想让它真的写字：换真模型（`demo/env.ts` 顶部两行 + 下面的 model
//     ref），并把 `writeReport()` 里「按 id 取语料正文」换成「取模型写的段落」；
//   - 每一步 prompt 里那些 `[[…]]` 是**假 provider 的脚本约定**，不是提示词写法示范。
//
// 七个面各至少出场一次，跑完打印一张自证表（数的是**真调用次数**）并断言每项 ≥ 1。
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgent } from "../src/index.ts";
import type { Agent, AgentMessage, AgentTool } from "../src/index.ts";
import { FAUX_MODEL_ALT_REF, FAUX_MODEL_REF } from "../examples/lib/faux-models.ts";
import { ensureEnv } from "./env.ts";

// ═══════════════ 0. 环境与语料 ═══════════════

const env = await ensureEnv();
const reportPath = join(env.cwd, "report.md");
const boardPath = join(env.cwd, "blackboard.jsonl");
const skillsRoot = join(env.cwd, "skills");

/**
 * 提示词适配：**假 provider 只会照脚本回话**（`examples/lib/faux-server.ts` 顶部的约定），
 * 所以要用 `[[tool:…]]` 指令告诉它调哪个工具、传什么参数；**真模型**得说人话，它自己决定怎么调。
 *
 * 这是两种模式的唯一分叉点 —— demo 的**流程**（谁先跑、哪一步升档、门拦什么）两边完全一样，
 * 这样「换成真模型」检验的是模型，不是被改写的流程。
 */
const ask = (fauxText: string, realText: string): string => (env.real ? realText : fauxText);

/** 语料：报告的事实来源。真实项目里这是你的资料库 / 检索接口。 */
interface Doc {
  id: string;
  tags: string[];
  title: string;
  text: string;
}

const CORPUS: Doc[] = [
  {
    id: "C1",
    tags: ["context", "压缩"],
    title: "上下文预算：裁的是「这一轮发出去的」，不是历史",
    text:
      "context.override 只改这一轮送到模型面前的那批消息，会话历史一条不动 —— 所以它可以逐轮收紧而不丢证据。" +
      "检索员的策略是「只发最后一条提问之后的内容」：提问与它触发的工具往返原样保留，更早的轮次整段让位。" +
      "这比压缩（compact）便宜，也比压缩更可预测：裁剪规则由设计者写死，不需要模型参与。",
  },
  {
    id: "C2",
    tags: ["tools", "白名单"],
    title: "工具白名单是裁剪，不是沙箱",
    text:
      "permissions.only 把工具集裁到设计者点名的几个：名单外的工具连注册表都进不去，模型看都看不到。" +
      "但它只是裁剪 —— pi 没有内置沙箱，被点名的高危工具照样能造成真破坏。" +
      "「能不能做」要靠审批门，不是靠名单，「能看不能看」才是名单的活。",
  },
  {
    id: "C3",
    tags: ["permissions", "审批门"],
    title: "审批门拦的是动作，不是人",
    text:
      "permissions.gate 在每次工具调用前拿到 {name, input}：返回 {block:true, reason} 就拦下，" +
      "reason 会作为工具结果回到模型面前，模型能读到「为什么不许」。" +
      "拦的是「这一次动作」而不是「这个工具」—— 所以判据要写在参数上，只拦工具名一定会漏。",
  },
  {
    id: "C4",
    tags: ["model", "分工"],
    title: "便宜的模型做检索，强的做写作",
    text:
      "model.set 是运行期换模型：同一个分身可以在检索阶段用便宜的档、写作阶段切到强档，" +
      "会话与工具集都跟着它走，不需要重建分身。" +
      "分工因此可以按「这一步值多少钱」来切，而不是按「谁更聪明」来切 —— 多数轮次不需要强模型。",
  },
  {
    id: "C5",
    tags: ["skills", "extensions", "装载"],
    title: "技能与扩展按角色装载",
    text:
      "技能与扩展都是按角色装的：检索员领检索规范，写作员领写作规范与引用检查扩展。" +
      "两者都可以在运行期 add —— 装完下一轮就生效，不需要重建分身；也能在创建期一次声明完。" +
      "装载失败不静默：skills.add 找不到 SKILL.md 会抛错，extensions.errors() 读得到加载期错误。",
  },
  {
    id: "C6",
    tags: ["io", "分身", "成员"],
    title: "同一个成员可以起多个分身",
    text:
      "成员是设计者写好的配置，分身是它的运行实例：同一条检索线复制成两个分身并行跑，" +
      "各自的会话、用量、黑板记录互不干扰。起几个分身是使用者代码的决定，库不参与。" +
      "投递也有区别：prompt 等这一轮跑完，queue 则把消息排进队列（忙时并进当前这一轮）。",
  },
];

const corpusById = new Map(CORPUS.map((doc) => [doc.id, doc]));

/** 关键词检索：语料里任一字段包含任一个词即命中（够用的土办法，换成真检索接口就是替换这一个函数） */
function findByKeyword(query: string): Doc[] {
  const words = query.split(/\s+/).filter(Boolean);
  return CORPUS.filter((doc) => words.some((word) => `${doc.title}${doc.text}${doc.tags.join("")}`.includes(word)));
}

function render(docs: Doc[]): string {
  if (!docs.length) return "（命中 0 条）";
  return docs.map((doc) => `[${doc.id}] ${doc.title}\n${doc.text}`).join("\n\n");
}

// ═══════════════ 1. 黑板：协作痕迹的唯一事实 ═══════════════
// 产物之一（demo/work/blackboard.jsonl）。工具写它、审批门写它、报告从它拼 —— 一处记录，多处读。

interface BoardEntry {
  seq: number;
  who: string;
  kind: string;
  [key: string]: unknown;
}

const entries: BoardEntry[] = [];

function record(who: string, kind: string, extra: Record<string, unknown> = {}): BoardEntry {
  const entry: BoardEntry = { seq: entries.length + 1, who, kind, ...extra };
  entries.push(entry);
  appendFileSync(boardPath, `${JSON.stringify(entry)}\n`);
  return entry;
}

const notes = () => entries.filter((e) => e.kind === "note") as (BoardEntry & { ids: string[] })[];
const drafts = () => entries.filter((e) => e.kind === "draft") as (BoardEntry & { heading: string; ids: string[] })[];

// ═══════════════ 2. 工具：agent 能做的事，由设计者点名 ═══════════════

/** 检索扩展：创建期装上的那个扩展，注册 search（关键词语料检索） */
function searchExtension(who: string): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool(
      defineTool({
        name: "search",
        label: "Search",
        description: "按关键词在本地语料里检索，返回命中的语料（id / 标题 / 正文）",
        parameters: Type.Object({ query: Type.String() }),
        execute: async (_id, params) => {
          const hits = findByKeyword(params.query);
          record(who, "search", { query: params.query, hits: hits.map((hit) => hit.id) });
          return { content: [{ type: "text" as const, text: render(hits) }], details: {} };
        },
      }),
    );
  };
}

/**
 * 按标签检索：**运行期**才加进来的第二件检索工具（tools 面）。
 * 这里写成成品（`AgentTool` 的两种形状都收：成品或 `(ctx) => 成品` 的工厂）。
 * 要检验这条，改成 X 再跑：把它改成工厂式 `(ctx) => defineTool({ … })` —— 行为应当一模一样
 * （`tools.add` 会在入表前把工厂调成成品，见 src/surfaces/tools.ts）。
 */
function searchByTagTool(who: string): AgentTool {
  return defineTool({
    name: "search_by_tag",
    label: "Search By Tag",
    description: "按标签（context / tools / permissions / model / skills / 分身 …）检索语料",
    parameters: Type.Object({ tag: Type.String() }),
    execute: async (_id, params) => {
      const hits = CORPUS.filter((doc) => doc.tags.includes(params.tag));
      record(who, "search", { tag: params.tag, hits: hits.map((hit) => hit.id) });
      return { content: [{ type: "text" as const, text: render(hits) }], details: {} };
    },
  });
}

/** 采信：把某几条语料记进黑板。id 不在语料里就明确报错，不静默丢条目。 */
function noteTool(who: string): AgentTool {
  return defineTool({
    name: "note",
    label: "Note",
    description: "把采信的语料 id 记进黑板（可以多条）",
    parameters: Type.Object({ ids: Type.Array(Type.String()) }),
    execute: async (_id, params) => {
      const known: string[] = [];
      const unknown: string[] = [];
      const already: string[] = [];
      const taken = new Set(notes().flatMap((entry) => entry.ids));
      for (const id of params.ids) {
        if (!corpusById.has(id)) unknown.push(id);
        else if (taken.has(id)) already.push(id);
        else known.push(id);
      }
      if (known.length) record(who, "note", { ids: known });
      const lines = [`采信 ${known.length} 条：${known.join("、") || "（无）"}`];
      if (already.length) lines.push(`已经采信过、跳过：${already.join("、")}`);
      if (unknown.length) lines.push(`语料里没有这些 id，未采信：${unknown.join("、")}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
    },
  });
}

/** 读黑板：写作员的输入。返回所有已采信的语料（正文），这就是报告的原料。 */
function readBoardTool(who: string): AgentTool {
  return defineTool({
    name: "read_blackboard",
    label: "Read Blackboard",
    description: "读黑板：已采信的语料全文（报告只能写这些，不许自己编）",
    parameters: Type.Object({}),
    execute: async () => {
      const taken = notes().flatMap((entry) => entry.ids);
      record(who, "read_board", { ids: taken });
      const body = taken.map((id) => render([corpusById.get(id)!])).join("\n\n");
      return { content: [{ type: "text" as const, text: body || "（黑板是空的）" }], details: {} };
    },
  });
}

/** 起草一节：标题 + 这一节要用的语料 id（大纲由模型给，正文由代码拼） */
function draftTool(who: string): AgentTool {
  return defineTool({
    name: "draft_section",
    label: "Draft Section",
    description: "草拟报告的一节：给标题 + 这一节引用的语料 id",
    parameters: Type.Object({ heading: Type.String(), ids: Type.Array(Type.String()) }),
    execute: async (_id, params) => {
      const missing = params.ids.filter((id) => !corpusById.has(id));
      record(who, "draft", { heading: params.heading, ids: params.ids, missing });
      const warn = missing.length ? `（有 ${missing.length} 条 id 不在语料里：${missing.join("、")}）` : "";
      return {
        content: [{ type: "text" as const, text: `已记入大纲：${params.heading}，引用 ${params.ids.length} 条${warn}` }],
        details: {},
      };
    },
  });
}

/** 破坏性工具：存在，是为了有一个东西可以被审批门拦下来 */
function clearBoardTool(who: string): AgentTool {
  return defineTool({
    name: "clear_blackboard",
    label: "Clear Blackboard",
    description: "清空黑板（会毁掉这次协作的全部痕迹）",
    parameters: Type.Object({ reason: Type.String() }),
    execute: async (_id, params) => {
      entries.length = 0;
      writeFileSync(boardPath, "");
      record(who, "clear_board", { reason: params.reason });
      return { content: [{ type: "text" as const, text: "黑板已清空" }], details: {} };
    },
  });
}

/** 引用检查扩展：**运行期**装上的扩展（extensions 面），注册 cite_check */
function citeCheckExtension(who: string): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool(
      defineTool({
        name: "cite_check",
        label: "Cite Check",
        description: "检查引用：这些语料 id 是否都在语料库里、是否都已采信",
        parameters: Type.Object({ ids: Type.Array(Type.String()) }),
        execute: async (_id, params) => {
          const taken = new Set(notes().flatMap((entry) => entry.ids));
          const missing = params.ids.filter((id) => !corpusById.has(id));
          const notTaken = params.ids.filter((id) => corpusById.has(id) && !taken.has(id));
          record(who, "cite_check", { ids: params.ids, missing, notTaken });
          const lines = [`引用检查：${params.ids.length} 条`];
          if (missing.length) lines.push(`不在语料里：${missing.join("、")}`);
          if (notTaken.length) lines.push(`还没采信：${notTaken.join("、")}`);
          if (!missing.length && !notTaken.length) lines.push("全部可核对");
          return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
        },
      }),
    );
  };
}

// ═══════════════ 3. 自证：七个面各自的调用次数 ═══════════════

const SURFACES = ["io", "context", "tools", "permissions", "extensions", "skills", "model"] as const;
type SurfaceName = (typeof SURFACES)[number];
const tally: Record<SurfaceName, number> = {
  io: 0,
  context: 0,
  tools: 0,
  permissions: 0,
  extensions: 0,
  skills: 0,
  model: 0,
};

/**
 * 自证表的唯一数据来源：给七个面各套一层计数代理，对它们的**写和方法调用**记一笔。
 *
 * 为什么用代理而不是在每个调用点旁边手写 `++`：手写的计数会跟调用点一起漂移（漏写一处就是一条
 * 假证据），代理漏不了 —— 把某次写删掉，这一项立刻变 0，自证表就会红。
 * 口径：**读数不算**。两类读数都得排除，否则「这一面出场过」会退化成「读到过它」：
 *   - 属性读数（`io.pending` / `model.current`）本来就进不来（下面 `typeof value !== "function"` 拦掉）；
 *   - 方法读数（`skills.list()` / `extensions.errors()`）是方法、会被计一笔，所以必须点名排除（`READS`）。
 */
const READS = new Set(["list", "errors"]); // 两个面上现有的读数方法

function watch(agent: Agent): Agent {
  for (const name of SURFACES) {
    const surface = agent[name] as unknown as object;
    const counted = new Proxy(surface, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== "function") return value;
        const reading = READS.has(String(prop)); // 读数：照原样转发，不计数
        return (...args: unknown[]) => {
          if (!reading) tally[name] += 1;
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    Object.assign(agent, { [name]: counted });
  }
  return agent;
}

// ═══════════════ 4. 成员规格与两个角色的起法 ═══════════════

/**
 * 「几个 agent」就是这个数组的长度。两条检索线 = 两个分身（同一个成员的实例）。
 * 要检验这条，改成 X 再跑：把这条数组减到 1 条（只留检索员-1）—— 采信语料缩到 C1、C2，
 * 「三、分工与装载」那一节的三条会逐条印成「—— 采信：(没人采信)」（正文照印，因为正文是代码
 * 按 id 从语料取的），账表里「大纲里引用了但没人采信的 id」会列出 C3、C4、C5、C6；
 * 反过来加成 3 条（再写一条检索线），看报告是否更全。
 */
interface ResearchLine {
  name: string;
  query: string;
  tag: string;
  ids: string[];
}

const RESEARCH_LINES: ResearchLine[] = [
  { name: "检索员-1", query: "上下文 白名单", tag: "tools", ids: ["C1", "C2"] },
  { name: "检索员-2", query: "审批门 分工 分身 装载", tag: "装载", ids: ["C3", "C4", "C5", "C6"] },
];

/**
 * context 面的策略：只发「最后一条 user 之后的内容」。起点永远是 user，所以不会把 assistant 的
 * tool_call 与它的 tool 结果拆开（拆开会让下一轮带着孤儿 tool 结果出门）。
 * 要检验这条，改成 X 再跑：改成 `(messages) => messages.slice(-2)`（可能把 tool 结果和它的
 * tool_call 拆开），或直接不装 override —— 判据是下面那张「context 钩子实测」表：不装 override
 * 它就是空的（表里的数字是在 override 回调里、由 pi 用真实那一批调出来的，不是我们自己另算一遍）。
 */
function squeeze(messages: AgentMessage[]): AgentMessage[] {
  const lastUser = messages.map((message) => message.role).lastIndexOf("user");
  return lastUser <= 0 ? messages : messages.slice(lastUser);
}

/**
 * 每个检索分身每轮：pi 交给 override 的条数（raw）→ override 返回、真发出去的条数（sent）。
 * 记录写在 **override 回调内部**（见 startResearcher）。不能写在 `on("context")` 监听器里 —— 那是
 * 循环论证：src/agent/bridge.ts 把**原始** event 交给监听器，override 的结果另走一条路回给 pi，
 * 监听器看不到裁剪后的那批，于是「装了 override 是全量、没装也是全量」，零判别力。
 */
const contextSamples: { who: string; raw: number; sent: number }[] = [];

interface Started {
  agent: Agent;
  line: ResearchLine;
}

/**
 * 一次「上线一个检索分身」要做的事：建分身 → 装上下文策略 → 领技能 → 装规格。
 * 要检验这条，改成 X 再跑：把下面 `permissions.only` 那一行删掉（护栏不要了）—— 分身会拿到
 * read / write / bash 等全套内置工具，`search_by_tag` 之外它还能读写你的磁盘；跑完对比工具声明。
 */
async function startResearcher(line: ResearchLine): Promise<Started> {
  const agent = watch(
    await createAgent({
      id: line.name,
      agentDir: env.agentDir,
      cwd: env.cwd,
      model: env.model, // 便宜的那档（检索不需要强模型）
      modelNetwork: env.real ? undefined : false,
      role: `检索员：只查语料库、只把采信的条目记进黑板；不写报告、不动别人的记录。你是${line.name}。`,
      extensions: [searchExtension(line.name)], // extensions 面（创建期声明）
      tools: { custom: [noteTool(line.name)] }, // tools 面（创建期声明）
      permissions: { only: ["note"] }, // 白名单：note + 上面那个扩展注册的 search 自动并入（见 src/agent/loader.ts）
      context: { autoCompact: false }, // 这个分身的上下文由 override 管，不要自动压缩掺一脚
    }),
  );
  // context 面（运行期写）+ 它的判据：记录写在回调内部，pi 用**真实那一批**调它。
  // 不装 override ⇒ 这张表一条都没有（所以「去掉 override」这个实验才看得出来）。
  agent.context.override((messages) => {
    const out = squeeze(messages);
    contextSamples.push({ who: line.name, raw: messages.length, sent: out.length });
    return out;
  });
  // skills 面（运行期写）：上线前领一张检索规范。
  // 要检验这条，改成 X 再跑：把 `skills.add` 换成创建期的 `skills: [路径]` 声明 —— 效果一样；
  // 区别在时机：运行期这条能让分身中途换规范，创建期那条不能。
  await agent.skills.add(join(skillsRoot, "research-style"));
  return { agent, line };
}

/** 写一张真实存在的 SKILL.md（skills.add 只接受路径，加载不出来会抛错、不静默降级） */
function writeSkill(dirName: string, name: string, description: string, body: string): void {
  const dir = join(skillsRoot, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

// ═══════════════ 5. 干活的流程 ═══════════════

const started: Started[] = [];
const agents: Agent[] = [];

async function main(): Promise<void> {
  console.log("[1] 环境（demo 自己的 agentDir / cwd，离线假 provider）");
  rmSync(reportPath, { force: true });
  rmSync(boardPath, { force: true });
  writeFileSync(boardPath, "");
  writeSkill("research-style", "research-style", "检索规范：只采信语料里的条目，注明 id", "先检索、再采信；采信要写 id。");
  writeSkill("writing-style", "writing-style", "写作规范：每节先给结论、再给依据", "一节一个论点，引用语料 id。");
  console.log(`    agentDir = ${env.agentDir}`);
  console.log(`    cwd      = ${env.cwd}`);
  console.log(`    语料     = ${CORPUS.length} 条（${CORPUS.map((doc) => doc.id).join("、")}）`);

  console.log(
    `[2] 成员与分身：检索员 ×${RESEARCH_LINES.length} + 写作员 ×1 = ${RESEARCH_LINES.length + 1} 个分身 —— 起几个是使用者代码的决定`,
  );
  for (const line of RESEARCH_LINES) started.push(await startResearcher(line));
  for (const { agent, line } of started) agents.push(agent);
  const writer = watch(
    await createAgent({
      id: "写作员",
      agentDir: env.agentDir,
      cwd: env.cwd,
      model: env.model, // 也用便宜档起，写作阶段再运行期升档（model 面）
      modelNetwork: env.real ? undefined : false,
      role: "写作员：把黑板上的材料组织成一份报告；不查新资料、不改别人的记录、不动黑板。",
      skills: [join(skillsRoot, "writing-style")], // 写作员的技能与检索员不同
      tools: {
        custom: [readBoardTool("写作员"), draftTool("写作员"), clearBoardTool("写作员")],
      },
      // 要检验这条，改成 X 再跑：把 only 里加上 "search"、再给写作员 searchExtension ——
      // 写作员就会自己查资料，跳过两个检索分身；同一份报告两条路的结果可直接对比。
      permissions: { only: ["read_blackboard", "draft_section", "clear_blackboard"] },
    }),
  );
  agents.push(writer);
  for (const { agent, line } of started) {
    const skills = agent.skills.list().map((skill) => skill.name).join("、") || "无";
    console.log(`    ${agent.id}  model=${agent.model.current?.id}  技能=[${skills}]  检索线=「${line.query}」/ 标签 ${line.tag}`);
  }
  console.log(
    `    ${writer.id}  model=${writer.model.current?.id}  技能=[${writer.skills.list().map((skill) => skill.name).join("、")}]` +
      `  extensions=${writer.extensions.list().length}  工具白名单=[${writer.io.raw.getActiveToolNames().join("、")}]`,
  );

  console.log("[3] 检索阶段：每个检索分身各查一轮，采信记进黑板");
  // 循环而不是写死两条：把 RESEARCH_LINES 加成 3 条时，第三个人也真的会跑（这就是上面那个「要检验这条」的改法）。
  // 只有第 1 条检索线额外做两件事：运行期加工具（tools 面）与用 queue 投递（io 面）。
  for (const [index, { agent, line }] of started.entries()) {
    const round = index + 1;
    await agent.io.prompt(
      ask(
        `检索线 ${round} 第一问：按关键词找语料。\n[[tool:search]] [[args:{"query":"${line.query}"}]]`,
        `检索线 ${round} 第一问：用 search 工具查关键词「${line.query}」，然后汇报命中的条目。`,
      ),
    );
    console.log(`    [${agent.id}] 第一问命中：${lastHits()}`);
    if (round === 1) {
      // tools 面（运行期写）：第一问回来发现关键词检索不够，补一个按标签检索的工具
      await agent.tools.add(searchByTagTool(agent.id));
      console.log(
        `    [${agent.id}] tools 面：运行期 add(search_by_tag) → 模型现在看得到 [${agent.io.raw.getActiveToolNames().join("、")}]`,
      );
      // io 面：queue 把第二问排进队列（此刻空闲 ⇒ 它起一轮但不等；结果靠 waitIdle 收）
      // 要检验这条，改成 X 再跑：让 queue 落在**忙**的时刻 —— 先 `const flying = agent.io.prompt("[[sleep:300]] …")`
      //（不等它），紧接着 `await agent.io.queue(第二问)`，看第二问是并进当前这一次运行还是另起一轮；
      // 两种情况下都得 waitIdle，否则 call 会撞「忙时不能改声明面」。
      await agent.io.queue(
        ask(
          `检索线 ${round} 第二问：按标签补一轮，然后把采信的记进黑板。\n` +
            `[[call:search_by_tag {"tag":"${line.tag}"}]] [[call:note {"ids":${JSON.stringify(line.ids)}}]]`,
          `检索线 ${round} 第二问：用 search_by_tag 工具按标签「${line.tag}」再查一轮，` +
            `然后用 note 工具把这些条目 id 记进黑板：${line.ids.join("、")}。`,
        ),
      );
      await agent.io.waitIdle();
    } else {
      await agent.io.prompt(
        ask(
          `检索线 ${round} 第二问：把采信的记进黑板。\n[[tool:note]] [[args:{"ids":${JSON.stringify(line.ids)}}]]`,
          `检索线 ${round} 第二问：用 note 工具把这些条目 id 记进黑板：${line.ids.join("、")}。`,
        ),
      );
    }
    console.log(`    [${agent.id}] 采信：${line.ids.join("、")}`);
  }
  if (contextSamples.length) {
    console.log(`    context 钩子实测（pi 交给 override 的条数 → 它返回、真发出去的条数）：`);
    for (const sample of contextSamples) {
      const trimmed = sample.raw > sample.sent ? "  ← 裁掉了" : "";
      console.log(`      ${sample.who}  ${sample.raw} → ${sample.sent}${trimmed}`);
    }
  } else {
    console.log(`    context 钩子实测：（空）—— 检索分身没装 override，没有一批被裁（这就是去掉它时的形状）`);
  }

  console.log("[4] 写作阶段：便宜的检索 → 强的写作");
  const modelBefore = `${writer.model.current?.id}/${writer.model.thinking}`;
  await writer.model.set(env.altModel); // model 面（运行期写）
  writer.model.setThinking("high");
  console.log(`    model 面：${modelBefore} → ${writer.model.current?.id}/${writer.model.thinking}`);
  // 要检验这条，改成 X 再跑：把上面 setThinking 那行删掉 —— 报告「这次协作的账」里写作员的档位会回到
  // off（那一行是按实际状态读的），其余流程一模一样：档位影响的是模型怎么想，不是流程怎么走。
  const extBefore = writer.extensions.list().length;
  await writer.extensions.add(citeCheckExtension("写作员")); // extensions 面（运行期写）
  console.log(
    `    extensions 面：运行期 add(引用检查) → ${extBefore} → ${writer.extensions.list().length} 个（errors=${writer.extensions.errors().length}）`,
  );

  // permissions 面：审批门就是这几行。「拦什么」是设计者写的判据，库只负责在每次调用前问一句。
  // 要检验这条，改成 X 再跑：把判据改成只拦 `/^rm_/`（去掉 clear_/delete_ 与参数关键字）——
  // 写作员那一下会真的把黑板清空，报告只剩壳：这就是门在干什么的直接证明。
  const gateReason = "写作员不许做这类会抹掉别人成果的操作；要清空黑板请改设计者代码，不要在会话里试";
  writer.permissions.gate(async (call) => {
    const blob = `${call.name} ${JSON.stringify(call.input)}`;
    const destructive = /^(clear|delete|rm)_/.test(call.name) || /清空|删除/.test(blob);
    record("写作员", "gate", { tool: call.name, verdict: destructive ? "拦下" : "放行" });
    return destructive ? { block: true, reason: gateReason } : undefined;
  });

  await writer.io.prompt(
    ask("先读黑板，看检索员留下了什么。\n[[tool:read_blackboard]]", "先读黑板，看检索员留下了什么。"),
  );
  const sections = [
    { heading: "一、上下文预算：裁的是这一轮，不是历史", ids: ["C1"] },
    { heading: "二、工具集与审批门：先裁能力，再拦动作", ids: ["C2", "C3"] },
    { heading: "三、分工与装载：便宜的检索、强的写作", ids: ["C4", "C5", "C6"] },
  ];
  await writer.io.prompt(
    ask(
      "起草三节，把采信过的语料分到各自的小节里。" +
        sections.map((x) => `\n[[call:draft_section ${JSON.stringify(x)}]]`).join(""),
      // 真模型下必须把「用工具、逐节调」说死：只说「起草三节」它会直接在回复里写，
      // 于是黑板没有留痕、下面的「大纲」一行是空的（实测踩到过）。
      "把报告分成三节，**每一节都调用一次 draft_section 工具**（这是留痕，不是可选项），三节依次调用：" +
        sections.map((x) => `\n- heading「${x.heading}」，ids 用 ${x.ids.join("、")}`).join(""),
    ),
  );
  console.log(`    大纲：${drafts().map((entry) => entry.heading).join(" ｜ ")}`);
  const cite = await writer.io.prompt(
    ask(
      '定稿前查一遍引用。\n[[tool:cite_check]] [[args:{"ids":["C1","C3","C9"]}]]',
      "定稿前用 cite_check 工具查一遍这些引用的 id：C1、C3、C9。",
    ),
  );
  const citeRan = entryOfKind("cite_check").length > 0; // 它真跑了才会在黑板上留下一笔（那一笔是工具自己写的）
  console.log(`    cite_check（${citeRan ? "运行期扩展注册的工具真跑了" : "没跑起来 —— 运行期扩展没生效"}）：${oneLine(cite.text)}`);
  const attempt = await writer.io.prompt(
    ask(
      '黑板有点乱，试着清掉它。\n[[tool:clear_blackboard]] [[args:{"reason":"看不清了"}]]',
      "黑板有点乱，试着用 clear_blackboard 工具清掉它。",
    ),
  );
  const blocked = entryOfKind("gate").filter((entry) => entry.verdict === "拦下");
  console.log(`    审批门：看过 ${entryOfKind("gate").length} 次调用，拦下 ${blocked.length} 次`);
  console.log(`    被拦后模型读到的是：${oneLine(attempt.text)}`);
  // 真模型下门常常**没机会拦**：它读了 role 里的边界，自己在会话里就拒绝了（拒不调工具），
  // 于是「拦下 0 次」不是门坏了，而是「护栏的顺序」这件事的可观察结果 ——
  // 角色边界（软约束，靠模型配合）在门前（硬约束，靠代码）就先生效了。
  // 这一行是**如实呈现**，不是断言：两种结果都合法，读者自己判断要不要靠 role 兜底。
  if (env.real && blocked.length === 0) {
    console.log(
      "      ↑ 注意：真模型下门可能一次都没机会拦 —— 它读了 role 里的边界，自己在会话里就拒绝了。" +
        "「角色边界」是软约束（靠模型配合），「审批门」是硬约束（靠代码，模型不配合也拦得住）——",
    );
    console.log(
      "        要检验这条：把 role 里的「不动黑板」删掉再跑，门就会被调用（这就是门存在的理由）。",
    );
  }

  console.log("[5] 汇总：报告由代码拼（黑板 + 语料），写到 demo/work/report.md");
  const report = writeReport(tally);
  console.log(`    ${reportPath}：${report.trimEnd().split("\n").length} 行；采信语料 ${new Set(notes().flatMap((n) => n.ids)).size} 条；黑板流水 ${entries.length} 条`);

  console.log("[6] 自证：七个面各自被调用了几次（数据来自计数代理，不是手写的数字）");
  const ok = selfCheck();
  console.log("");
  if (!ok) {
    process.exitCode = 1; // 不 process.exit()：Windows 上它会把退出码变成 127（见 demo/check.ts 的注释）
    return;
  }
  console.log("全部跑通 —— 报告在 demo/work/report.md。改一处设计决策、再跑一次，就能检验那条假设。");
}

/** 黑板里最近一条 search 的命中（打印用） */
function lastHits(): string {
  const searches = entries.filter((entry) => entry.kind === "search");
  const last = searches[searches.length - 1];
  return ((last?.hits as string[]) ?? []).join("、") || "（0 条）";
}

function entryOfKind(kind: string): BoardEntry[] {
  return entries.filter((entry) => entry.kind === kind);
}

function oneLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ═══════════════ 6. 报告由代码拼出（假 provider 不会写字，见文件头） ═══════════════

function writeReport(counts: Record<SurfaceName, number>): string {
  const findings = notes();
  const owner = new Map<string, string>();
  for (const finding of findings) for (const id of finding.ids) if (!owner.has(id)) owner.set(id, finding.who);
  const cited = [...owner.keys()];
  const blocked = entryOfKind("gate").filter((entry) => entry.verdict === "拦下");
  const gaps = drafts().flatMap((entry) => entry.ids).filter((id) => !owner.has(id));

  const out: string[] = [
    "# 七个操控面，撑起一次多 agent 协作",
    "",
    "> 本文件由 `demo/agent-team.ts` 的 `writeReport()` 从**黑板 + 语料**拼出 —— 假 provider 不会写字。",
    "> 「模型」在这次协作里决定的是**调用顺序与取舍**（查什么、采信哪几条、报告分几节），它们经工具参数",
    "> 落进黑板，再由代码兑现成文。想让它真的写字：换真模型（`demo/env.ts` 顶部两行）并把这里「按 id",
    "> 取语料正文」换成「取模型写的段落」。",
    "",
    "## 这次协作的账",
    "",
    "| 项 | 值 |",
    "|---|---|",
    `| 分身 | ${agents.map((agent) => agent.id).join("、")}（${agents.length} 个：检索员 ×${RESEARCH_LINES.length}、写作员 ×1） |`,
    `| 模型 | ${agents.map((agent) => `${agent.id} ${agent.model.current?.id}/${agent.model.thinking}`).join("；")} |`,
    `| 分工（各分身实际看得到的工具） | ${agents.map((agent) => `${agent.id} [${agent.io.raw.getActiveToolNames().join("、")}]`).join("；")} |`,
    `| 黑板流水 | ${entries.length} 条（检索 ${entryOfKind("search").length} / 采信 ${findings.length} / 读板 ${entryOfKind("read_board").length} / 起草 ${drafts().length} / 门 ${entryOfKind("gate").length} / 引用检查 ${entryOfKind("cite_check").length}） |`,
    `| 采信语料 | ${cited.join("、") || "（无）"} |`,
    `| 被审批门拦下 | ${blocked.map((entry) => `${entry.tool}（${entry.who}）`).join("、") || "（无）"} |`,
    `| 大纲里引用了但没人采信的 id | ${gaps.length ? gaps.join("、") : "（无）"} |`,
    "",
  ];

  for (const section of drafts()) {
    out.push(`## ${section.heading}`, "");
    for (const id of section.ids) {
      const doc = corpusById.get(id);
      if (!doc) {
        out.push(`- ${id}：语料里没有这一条（draft_section 当时报了 missing，这里也不编）`, "");
        continue;
      }
      out.push(`### ${doc.id} · ${doc.title}`, "", doc.text, "");
      out.push(`—— 采信：${owner.get(id) ?? "(没人采信)"}；标签：${doc.tags.join("、")}`, "");
    }
  }

  out.push("## 附一：七面各被调用了几次（demo 自证；数据来自计数代理，不是手写的数字）", "", "| 面 | 次数 |", "|---|---|");
  for (const name of SURFACES) out.push(`| \`${name}\` | ${counts[name]} |`);
  out.push("", "## 附二：黑板流水（这次协作的每一笔）", "");
  for (const entry of entries) out.push(`- #${entry.seq} ${entry.who} · ${entry.kind} · ${JSON.stringify(rest(entry))}`);

  const text = `${out.join("\n")}\n`;
  writeFileSync(reportPath, text);
  return text;
}

/** 打印时把 seq / who / kind 摘掉，只留这笔记录的细节 */
function rest(entry: BoardEntry): Record<string, unknown> {
  const detail: Record<string, unknown> = { ...entry };
  delete detail.seq;
  delete detail.who;
  delete detail.kind;
  return detail;
}

function selfCheck(): boolean {
  let ok = true;
  for (const name of SURFACES) {
    const count = tally[name];
    if (count < 1) ok = false;
    console.log(`    ${name.padEnd(11)} ${String(count).padStart(3)}  ${"█".repeat(Math.min(count, 24))}`);
  }
  if (!ok) {
    const missing = SURFACES.filter((name) => tally[name] < 1);
    console.log(`    自证失败：${missing.join("、")} 一次都没出场 —— 那是设计缺陷，修设计，不要删断言。`);
    return false;
  }
  console.log("    七面全部 ≥ 1 ✓");
  return true;
}

await main();
for (const agent of agents) agent.dispose();
