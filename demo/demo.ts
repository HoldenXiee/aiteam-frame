// demo/demo.ts —— 真模型端到端：形态 5「团队内部探讨直到收敛」（会产生真实 API 花费，都用便宜模型）
// 跑法：npm run demo
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, createAgentHost, type ControlledAgent } from "../src/index.ts";

const TOPIC = process.env.DEMO_TOPIC ?? "阶段 2 应该先做并发闸门，还是先做 agent 之间的消息总线？";

/** 档案员把结论写到自己的 cwd（临时目录），不污染仓库 */
const outDir = mkdtempSync(join(tmpdir(), "aiteam-demo-"));

const members = {
  moderator: {
    description: "主持人：挑人、派活、在成员之间转发观点，最后给出结论",
    role: "你是这场讨论的主持人。只从花名册里挑人，派活时说清楚要对方做什么。",
    model: "opencode-go/deepseek-v4.1-flash",
    tools: ["spawn_agent", "send_message"],
  },
  reviewer: {
    description: "审查员：专挑风险、成本与遗漏，不看乐观面",
    role: "你是审查员，职责是把最容易翻车的地方挑出来，可以直接读仓库里的文件。",
    model: "opencode-go/mimo-v2.6-flash",
    tools: ["read"],
  },
  optimist: {
    description: "乐观派：专讲收益、可行性与最省的路",
    role: "你负责讲清好处与最短落地路径。你没有任何工具，只能凭已有的信息回答。",
    model: "opencode-go/qwen3.8-flash",
    tools: [],
  },
  archivist: {
    description: "档案员：把交给它的结论原样写成 markdown 文件，不参与争论",
    role: "你只负责把交办的内容写进指定的 md 文件，然后一句话确认。",
    model: "opencode-go/glm-5.3-flash",
    cwd: outDir,
    tools: ["read", "write"],
  },
};

const host = createAgentHost({ members, maxAgents: 8, maxDepth: 2, budgetTokens: 400_000 });
const byMember = new Map<string, ControlledAgent>();

host.on("agent_created", ({ agent, member }) => {
  // 同一个成员可能被起过多个分身（前一个失败后重试），以最后一个为准
  if (member) byMember.set(member, agent);
  console.log(`  · 分身就位：${member ?? "(顶层)"} ${agent.id}`);
});
host.on("round_completed", ({ agent, result }) => {
  const err = result.error ? `  [出错] ${result.error}` : "";
  console.log(`  · ${agent.member}(${agent.id}) 跑完一轮 +${result.usage.totalTokens} tokens${err}`);
});

const short = (text: string | undefined, n = 160) => (text ?? "(空)").replace(/\s+/g, " ").slice(0, n);

console.log(`议题：${TOPIC}\n`);

const moderator = await createAgent({ ...members.moderator }, { host, member: "moderator" });

console.log("第 1 轮：主持人挑两名成员，各要一句初始立场");
await moderator.prompt(
  `议题：${TOPIC}\n请用 spawn_agent 同时挑两名成员：reviewer（挑风险）与 optimist（讲收益），各要一句立场。`,
);
const reviewer = byMember.get("reviewer");
const optimist = byMember.get("optimist");
if (!reviewer || !optimist) {
  console.log("\n主持人没有把两个分身都挑出来，后面的轮次没法继续。");
  host.dispose();
  process.exit(1);
}
console.log(`  reviewer 立场：${short(reviewer.lastResult?.text)}`);
console.log(`  optimist 立场：${short(optimist.lastResult?.text)}`);

console.log("\n第 2 轮：主持人把两方观点互投（复用同一对分身）");
await moderator.prompt(
  `请用 send_message 把双方观点互投：告诉 ${reviewer.id}「optimist 的观点是：${short(optimist.lastResult?.text, 300)}」；` +
    `告诉 ${optimist.id}「reviewer 的观点是：${short(reviewer.lastResult?.text, 300)}」。各回一句是否改变立场。`,
);
await Promise.all([reviewer.waitForIdle(), optimist.waitForIdle()]);
console.log(`  reviewer 回应：${short(reviewer.lastResult?.text)}`);
console.log(`  optimist 回应：${short(optimist.lastResult?.text)}`);

console.log("\n第 3 轮：设计者把双方回应回灌给主持人（send 本身不带回复通道，靠 lastResult 读）")
await moderator.prompt(
  `双方回应来了：\nreviewer 说：「${short(reviewer.lastResult?.text, 300)}」\n` +
    `optimist 说：「${short(optimist.lastResult?.text, 300)}」\n现在给你自己的最终结论：三句话以内，说清先做什么、为什么。`,
);
console.log(`\n最终结论：\n${moderator.lastResult?.text ?? "(空)"}`);

const conclusionFile = join(outDir, "conclusion.md");
console.log("\n第 4 轮：让档案员把结论落盘（它有独立 cwd 和另一套工具）");
await moderator.prompt(
  `请用 spawn_agent 让 archivist 把下面这段结论原样写进这个绝对路径：${conclusionFile}\n\n${moderator.lastResult?.text ?? ""}`,
);
const archivist = byMember.get("archivist");
console.log(`  archivist 回复：${short(archivist?.lastResult?.text, 200)}`);
console.log(
  existsSync(conclusionFile)
    ? `\n档案员写下的文件 ${conclusionFile}：\n${readFileSync(conclusionFile, "utf-8")}`
    : `\n档案员没写出 ${conclusionFile}（见上面各轮输出）`,
);

console.log(
  `\n宿主统计：存活分身 ${host.list().length} 个；累计 ${host.usage.totalTokens} tokens，花费 $${host.usage.cost.total.toFixed(4)}`,
);
console.log(`成员配置差异：${Object.entries(members).map(([n, m]) => `${n}(${m.model.split("/")[1]}, tools=${JSON.stringify(m.tools)})`).join(" / ")}`);

host.dispose();
process.exit(0);
