// E2：真模型从花名册挑人 —— description 是它的唯一依据。
// 三种花名册：清晰（6 人）/ 8 人更大 / 故意相似模糊（最接近真实现场）。
// 跑法：node audit/22-topology-live/e2-roster-picking.ts [--smoke]   （真模型，并发 2）
import { createAgent, createAgentHost, type AgentHost } from "../../src/index.ts";
import { FLASH, ci, makeSink, pool, turn, workDir, type ToolCallRec } from "./_lib.ts";

const SMOKE = process.argv.includes("--smoke");
const sink = makeSink("e2-roster-picking");
const CONC = 2;
const cwd = workDir("e2");
const MULT = SMOKE ? 0.5 : 1; // 冒烟时样本减半（向下取整，至少 1）

// ─────────────── 花名册 A：6 人，description 区分度高 ───────────────
const ROSTER_CLEAR = {
  security: { description: "安全审查员：只看注入、越权、密钥泄漏风险" },
  perf: { description: "性能工程师：只看复杂度、内存、并发瓶颈" },
  ux: { description: "体验设计师：只看交互流程与文案" },
  legal: { description: "合规顾问：只看许可证与数据合规" },
  i18n: { description: "本地化专员：只看多语言与区域格式" },
  docs: { description: "文档工程师：只看注释与 README 完整性" },
};
const CASES_CLEAR = [
  { task: "有人把数据库连接串硬编码进了源码，我想知道有没有泄漏风险。", expect: "security" },
  { task: "这个列表页在 10 万条数据时会卡，我想知道瓶颈在哪。", expect: "perf" },
  { task: "我们的 README 里没有安装步骤。", expect: "docs" },
  { task: "这个功能上线要过欧盟的 GDPR。", expect: "legal" },
  { task: "用户说这个下拉菜单在手机上点不到。", expect: "ux" },
  { task: "文案里的日期格式在美国显示成了 10/9/2026，欧洲同事看不懂。", expect: "i18n" },
];

// ─────────────── 花名册 B：8 人 ───────────────
const ROSTER_8 = {
  ...ROSTER_CLEAR,
  data: { description: "数据工程师：只看埋点、报表口径、数据质量" },
  ops: { description: "运维工程师：只看部署、监控、回滚与容量" },
};
const CASES_8 = [
  ...CASES_CLEAR,
  { task: "我们的埋点漏掉了支付成功这个事件，报表口径可能不对。", expect: "data" },
  { task: "这次发布的回滚脚本没人写过，出事只能手工改。", expect: "ops" },
];

// ─────────────── 花名册 C：故意相似 / 模糊（真实现场） ───────────────
const ROSTER_FUZZY = {
  helper1: { description: "助手：处理用户的问题" },
  helper2: { description: "助手：协助处理问题" },
  helper3: { description: "助手：负责技术支持" },
  expertA: { description: "专家：给出专业意见" },
  expertB: { description: "专家：提供专业建议" },
  expertC: { description: "高级专家：给出权威判断" },
  workerA: { description: "工人：执行任务" },
  workerB: { description: "工人：完成任务" },
};
/** 模糊册没有客观正确答案 —— 这里定义「设计者本意」并允许「同义成员」算命中 */
const CASES_FUZZY = [
  { task: "用户的支付按钮点了没反应，需要有人处理这个问题。", expect: "helper1", also: ["helper2", "helper3"] },
  { task: "这个方案需要一个权威判断，别人说的都不算。", expect: "expertC", also: ["expertA", "expertB"] },
  { task: "把这份任务执行掉。", expect: "workerA", also: ["workerB"] },
  { task: "需要技术支持，服务器起不来了。", expect: "helper3", also: ["helper1", "helper2"] },
];

interface RunRec {
  roster: string;
  i: number;
  caseIdx: number;
  task: string;
  expect: string;
  also: string[];
  picked: string | undefined;
  calls: ToolCallRec[];
  ok: boolean;
  softOk: boolean;
  mode: string;
  tokens: number;
  cost: number;
  ms: number;
  finalText: string;
}

async function ask(
  rosterName: string,
  roster: Record<string, { description: string }>,
  cases: Array<{ task: string; expect: string; also?: string[] }>,
  i: number,
): Promise<RunRec> {
  const c = cases[i % cases.length];
  const host: AgentHost = createAgentHost({
    defaults: { model: FLASH },
    members: roster as never,
    maxAgents: 12,
  } as never);
  const lead = await createAgent({ model: FLASH, cwd, tools: ["spawn_agent"] }, { host });
  const t = await turn(
    lead,
    `${c.task}\n只挑一个成员，用 spawn_agent 把 task 设为「就按你的职责给一句判断」。`,
  );
  const spawned = host.list().filter((a) => a.member);
  const picked = spawned.length === 1 ? spawned[0].member : spawned.map((a) => a.member).join("+");
  const also = c.also ?? [];
  const rec: RunRec = {
    roster: rosterName,
    i,
    caseIdx: i % cases.length,
    task: c.task,
    expect: c.expect,
    also,
    picked,
    calls: t.calls,
    ok: picked === c.expect,
    softOk: picked === c.expect || (spawned.length === 1 && also.includes(spawned[0].member!)),
    mode: "",
    tokens: host.usage.totalTokens,
    cost: host.usage.cost.total,
    ms: t.ms,
    finalText: t.text,
  };
  if (t.error) rec.mode = "抛错";
  else if (!spawned.length) rec.mode = t.calls.length ? "调了工具但没建出分身" : "不调用工具";
  else if (spawned.length > 1) rec.mode = `一次起了 ${spawned.length} 个（要求只挑一个）`;
  else rec.mode = rec.ok ? "严格命中" : rec.softOk ? "命中同义成员" : "选错";
  host.dispose();
  return rec;
}

async function block(
  name: string,
  roster: Record<string, { description: string }>,
  cases: Array<{ task: string; expect: string; also?: string[] }>,
  perCase: number,
) {
  sink.section(`${name}：${Object.keys(roster).length} 个成员 × ${cases.length} 题 × ${perCase} 次`);
  const idx = [];
  for (let c = 0; c < cases.length; c++) for (let k = 0; k < perCase; k++) idx.push(c);
  const recs = await pool(idx, CONC, async (c) => {
    const r = await ask(name, roster, cases, c);
    console.log(`${r.softOk ? "✓" : "✗"} ${r.roster}#${r.i} 题${r.caseIdx + 1} 期望=${r.expect} 实际=${r.picked ?? "(无)"} mode=${r.mode} ${r.ms}ms $${r.cost.toFixed(6)}`);
    return r;
  });
  return recs;
}

const perCase = SMOKE ? 1 : 2;
const blocks: Array<{ name: string; roster: any; cases: any[] }> = [
  { name: "A-清晰6人", roster: ROSTER_CLEAR, cases: CASES_CLEAR },
  { name: "B-清晰8人", roster: ROSTER_8, cases: CASES_8 },
  { name: "C-模糊8人", roster: ROSTER_FUZZY, cases: CASES_FUZZY },
];

const all: RunRec[] = [];
for (const b of blocks) {
  const recs = await block(b.name, b.roster, b.cases, perCase);
  all.push(...recs);
  const strict = recs.filter((r) => r.ok).length;
  const soft = recs.filter((r) => r.softOk).length;
  const modes = recs.reduce<Record<string, number>>((a, r) => ({ ...a, [r.mode]: (a[r.mode] ?? 0) + 1 }), {});
  const perCaseRows = b.cases.map((c, ci2) => {
    const sub = recs.filter((r) => r.caseIdx === ci2);
    const s = sub.filter((r) => r.ok).length;
    return `题${ci2 + 1}(期望${c.expect}): ${s}/${sub.length} → ${sub.map((r) => r.picked ?? "(无)").join("/")}`;
  });
  sink.add({
    id: `E2-${b.name.split("-")[0]}`,
    question: `${b.name}（${Object.keys(b.roster).length} 个成员）下真模型按任务选人的严格命中率`,
    method: "node audit/22-topology-live/e2-roster-picking.ts（真模型；从 host.list() 读实际建出的 member 做 ground truth）",
    observed: [
      `严格命中 ${strict}/${recs.length}（${ci(strict, recs.length)}）；宽松命中（同义成员也算）${soft}/${recs.length}（${ci(soft, recs.length)}）`,
      `失败模式分布 ${JSON.stringify(modes)}`,
      `逐题：${perCaseRows.join("；")}`,
      `合计 ${recs.reduce((a, r) => a + r.tokens, 0)} token / $${recs.reduce((a, r) => a + r.cost, 0).toFixed(5)}`,
    ].join("\n     "),
    verdict: strict === recs.length ? "OK" : strict >= recs.length * 0.8 ? "PARTIAL" : "GAP",
    conclusion: `${b.name}：严格 ${strict}/${recs.length}，宽松 ${soft}/${recs.length}。${
      strict === recs.length ? "本次样本内零错。" : `错在：${JSON.stringify(modes)}`
    }`,
    data: { strict, soft, n: recs.length, modes, perCaseRows, recs },
  });
  sink.ledger(`runs-${b.name}`, recs);
}

const total = all.reduce((a, r) => a + r.cost, 0);
const totalTok = all.reduce((a, r) => a + r.tokens, 0);
sink.ledger("total", { runs: all.length, tokens: totalTok, cost: total });
console.log(`\nE2 结束：${all.length} 次真模型运行，合计 ${totalTok} token / $${total.toFixed(5)}`);
console.log(`→ ${sink.path}`);
void MULT;
