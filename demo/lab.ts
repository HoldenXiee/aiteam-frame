// demo/lab.ts —— 实验起点：demo/ 是一个**实验脚手架**，不是展示品。复制它、改它、跑它。
//
// 跑法：node demo/lab.ts                    （真模型：opencode-go/space-bunny-free，免费档）
//       AITEAM_DEMO_MODEL=provider/id node demo/lab.ts   （换模型）
//       AITEAM_DEMO_AUTH=/path/to/auth.json node demo/lab.ts （换凭证）
//       cp -r demo demo-exp1 && node demo-exp1/lab.ts      （开始你自己的实验：环境跟着复制走）
//
// ⚠️ 这个 demo **跑真模型**：每次运行都会真的调 provider（space-bunny-free 是免费档，但不保证无限量）。
//    没网、没凭证会明确报错（不会静默退回别的来源）——凭证放 `demo/agent/auth.json`。
//
// 怎么读：下面七段各是一个「改这里」的锚点。七面**没有**全出场 —— 这本身就是「一份实验只关心自己
// 那几个面」。刻意不演示：interrupt / reset / compact / skills.add / extensions.add / onResult。
// 要七面全出场、带自证表与 mutation 判据的完整案例：examples/12-team.ts（那个走本机假 provider）。
// 环境自检八项：demo/check.ts。
//
// 真模型与假 provider 的**一处本质差异**（这个脚手架按真模型写）：提示词是**自然语言**，不是脚本指令。
// 模型自己决定调不调工具，所以「它一定调了某个工具」不能当断言用 —— 想看它实际调了什么，
// 第 5 段的事件收集（`on("tool_call")`）就是为此存在的，它记的是**观测到的事实**，不是期望。
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { createLab, type Agent, type AgentTool } from "../src/index.ts";
import { ensureEnv } from "./env.ts";

// ═══ 0. 环境：环境在这里声明**一次**，本实验室起的所有分身共用（起 agent 时不再逐个传）═══
const env = await ensureEnv();
const lab = await createLab({
  agentDir: env.agentDir, // demo/agent/：技能与扩展是仓库里看得见、可手改的真文件
  cwd: env.cwd, // demo/work/：agent 在哪干活、产物落哪
});
console.log(`[0] 环境 = ${env.agentDir}`);
console.log(`    cwd = ${env.cwd}  model = ${env.model}`);

// ═══ 1. 模板：一个「成员」就是一个普通对象。库不提供花名册 —— 模板/花名册都是你代码里的对象（DESIGN.md）═══
interface Member {
  name: string;
  model?: string;
  tools?: AgentTool[];
  /** 精确白名单：集合就是这些（创建期只有 only；运行期才有并集语义的 allow） */
  only?: string[];
  /** 显式注入技能路径。⚠️ 声明的路径加载不出技能会**抛错**，所以环境里那份 env-style 走自动发现、不写这 */
  skills?: string[];
}

const 检索员: Member = {
  name: "检索员",
  model: env.model,
  tools: [toolSearch], // 自定义工具 —— 定义在第 3 段（AgentTool 允许传工厂，函数声明会提升）
  only: ["tool_search"], // 能力裁剪：它连读文件的工具都看不到
};
const 写作员: Member = {
  name: "写作员",
  model: env.model,
  only: ["read", "write"], // 裁剪到只够干活：没有 bash、没有 edit
};

// ═══ 2. 起分身：同一个实验室、同一份环境，按模板起几个就是几个 ═══
const [检索, 写作] = [
  await lab.createAgent({
    id: 检索员.name,
    model: 检索员.model,
    skills: 检索员.skills,
    tools: { custom: 检索员.tools },
    permissions: { only: 检索员.only },
  }),
  await lab.createAgent({ id: 写作员.name, model: 写作员.model, permissions: { only: 写作员.only } }),
] as [Agent, Agent];
console.log(`[2] 起了 2 个分身：${[检索, 写作].map((a) => `${a.id}(${a.model.current?.id})`).join("、")}`);

/** 审批门：每次工具调用**前**拿到 {name, input}，返回 {block:true, reason} 就拦下 —— 策略在你这 */
const 被拦: string[] = [];
写作.permissions.gate(async (call) => {
  // ⚠️ 真模型下这扇门可能**一次都不响**：模型读了 role 就不会去写危险路径。那不是门坏了。
  // 「门活着」的硬判据在 demo/check.ts 第 8 项（那里它会被真调用一次）；
  // 这里只把**观测到的事实**说清楚：看过了几次、拦下了几次。
  const blob = `${call.name} ${JSON.stringify(call.input)}`;
  if (/清空|删除|rm -rf/i.test(blob)) {
    const verdict = { block: true as const, reason: "写作员不许删东西；要清空请改设计者代码，不要在会话里试" };
    被拦.push(call.name);
    console.log(`    [门] 拦下 ${call.name}：${JSON.stringify(verdict)}`);
    return verdict;
  }
  return undefined; // 不拦 —— 只在真危险时说话
});

// ═══ 3. 自定义工具：`tools.custom` 是研究里最常用的扩展点（DESIGN.md）—— 检索/统计/评测工具都从这进 ═══
/** 6 条内联语料。真实项目里这是你的资料库 / 检索接口 —— 脚手架不替你决定数据放哪。 */
const 语料 = [
  { id: "C1", text: "context.override 裁的是**这一轮**发给模型的内容，历史照常增长" },
  { id: "C2", text: "permissions 是能力裁剪 + 拦截，不是权限系统；扩展与 bash 可以绕过它" },
  { id: "C3", text: "工具集分两层：创建期声明有哪些，运行期按白名单决定哪些**允许被调用**" },
  { id: "C4", text: "事件是 pi 原样透传的 ExtensionEvent —— 想拿什么材料就自己收集" },
  { id: "C5", text: "同一份环境可以起多个分身，各自换模型、换工具集，互不干扰" },
  { id: "C6", text: "一次运行 = agent_start 到 agent_settled，结算在 RunResult 里" },
];

/** 在 6 条语料里按关键词找 —— 一个最朴素的自定义工具，就是一份普通的 pi 工具定义 */
function toolSearch(): ToolDefinition {
  return defineTool({
    name: "tool_search",
    label: "Search",
    description: "在 6 条内联语料里按关键词找，返回命中的 id 与原文",
    parameters: Type.Object({ query: Type.String() }),
    execute: async (_id, { query }) => {
      const hits = 语料.filter((d) => d.text.includes(query));
      return {
        content: [
          {
            type: "text" as const,
            text: hits.length ? hits.map((d) => `${d.id}: ${d.text}`).join("\n") : `没有命中「${query}」`,
          },
        ],
        details: {},
      };
    },
  });
}

// ═══ 5. 观测：想拿什么材料就自己收集 —— 研究工具的一半在这（事件 / 上下文 / 结算）═══
// ⚠️ **监听要在投递之前布好**。事件是「发生的那一刻」推给监听者的，不是事后可查的记录 ——
// 装在跑完之后，前面几轮的调用就永远收不到了（这个脚手架第一版就踩过：打印出来是「0 次」）。
const 工具序列: string[] = [];
let 结算次数 = 0;
for (const a of [检索, 写作]) {
  // 按名收窄：event 已经是 ToolCallEvent，不用自己 cast。handler 要写成块体（返回值撞形状守卫）
  a.on("tool_call", (event) => {
    工具序列.push(`${a.id}:${event.toolName}`);
  });
}
检索.onAny((event) => {
  if (event.type === "agent_settled") 结算次数 += 1; // 全量：横切观测（trace / 日志）要的形状
});

// ═══ 4. 跑：交办 —— io.prompt 投递并等这轮完；io.queue 排队投递（目标忙就排队，不谎报已跑过）═══
// 真模型的提示词是**自然语言**：说清要什么，由它决定调不调工具。别写 [[tool:…]] 那些脚本标记
//（那是假 provider 的约定，真模型只会把它当正文回你「我没执行」）。
const 检索轮 = await 检索.io.prompt("请用 tool_search 搜「白名单」，把命中的语料 id 和原文列出来。");
if (检索轮.error) throw new Error(`检索那一轮失败了：${检索轮.error}`);
console.log(`[4] 检索员说：${oneLine(检索轮.text)}`);

// 排队投递：目标忙就并进当前这轮，闲就另起一轮 —— 两种情形都返回 {queued:true}，不谎报「已跑过」
const 排队 = await 检索.io.queue("再搜一次「事件」，同样列出命中的 id 与原文。");
console.log(`    io.queue → ${JSON.stringify(排队)}`);
await 检索.io.waitIdle(); // 排队那轮跑完再往下（要碰声明面就必须先 idle）

const 写作原档 = 写作.model.current?.id;
// 换思考档：同一个模型、不同档位。**这是真的会变的东西** —— space-bunny-free 支持 low/medium/high/xhigh/max。
// （比「换个更强的模型」更适合当脚手架示例：那种写法要先有第二个模型，而 demo 只声明一个。）
const 原思考 = 写作.model.thinking;
const 可用档 = 写作.model.raw.session.getAvailableThinkingLevels();
const 升档 = 可用档.includes("high") ? "high" : 可用档[可用档.length - 1]!;
写作.model.setThinking(升档); // 不打断在飞那轮，改动从**下一次请求**起生效
console.log(`    写作员升档：${写作原档}/${原思考} → ${写作.model.current?.id}/${写作.model.thinking}（可用档：${可用档.join("、")}）`);
// 两个分身之间怎么交接：**设计者自己选**。库不提供通道，这里用一种最直接的 ——
// 把上游的 RunResult.text 拼进下游的提示词。另一种做法是让它们通过共享外部状态（文件 / 黑板）
// 交换，那就得给它们一个能读写那个状态的工具（见 examples/12-team.ts 的黑板）。
const 动笔轮 = await 写作.io.prompt(
  `根据下面这段检索结果，把结论写进 notes.md。\n\n检索结果：\n${检索轮.text}`,
);
console.log(`    写作员说：${oneLine(动笔轮.text)}`);

// 上下文操控：override 只改「这一轮发什么」，entries() 是可寻址的会话条目
const 覆盖前 = 检索.context.history.length;
检索.context.override((messages) => messages.slice(-1)); // 这一轮只发最后 1 条
await 检索.io.prompt("用一句话说出你记得的最后一条语料是什么。");
检索.context.override(undefined); // 清除：下一轮恢复全量
console.log(`[5] override 生效：这一轮只发最后 1 条（\`slice(-1)\`），而 history 照常增长 ${覆盖前} → ${检索.context.history.length}`);
const entries = 检索.context.entries();
console.log(`    entries() 可寻址条目 ${entries.length} 条（带 id，能拿去 replace/erase）：${entries.slice(0, 3).map((e) => `${e.id.slice(0, 8)}(${e.role})`).join("、")}…`);
console.log(`    事件（监听自第 4 段之前就在位，所以这几轮全在）：tool_call ${工具序列.length} 次 [${工具序列.join(", ") || "模型这几次没调工具"}]；agent_settled ${结算次数} 次`);

// ═══ 6. 打印：这里换成你自己的分析（下面几行就是「读什么」的样板）═══
console.log("\n[6] 结果");
for (const a of [检索, 写作]) {
  console.log(`    ${a.id}：model=${a.model.current?.id} 累计 tokens=${a.usage.totalTokens} 状态=${a.status}`);
}
console.log(`    检索员这轮文本（RunResult.text）：${oneLine(检索轮.text)}`);
console.log(`    工具调用序列（on("tool_call") 收到）：${工具序列.join(" → ") || "（这一轮模型没调工具）"}`);
console.log(`    审批门看过的调用：拦下 ${被拦.length} 次 [${被拦.join(", ") || "没触发"}] —— 模型不写危险路径时门不会响，那是正常的`);
console.log(`    检索员可寻址条目（context.entries()）：${检索.context.entries().length} 条`);
console.log(`    产物：${join(env.cwd, "notes.md")} —— 写作员的 write 工具用了实验室的 cwd`);

console.log("\n改这里：把你的分析写在这；下一个实验：cp -r demo demo-exp1 && node demo-exp1/lab.ts");
for (const a of [检索, 写作]) a.dispose();

/** 一行摘要：真模型的回复是多段 markdown，打印时压成一行 */
function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
