// demo/run.ts —— 一条命令验完：库的依赖 → 自建环境 → 真模型 → agent 集群 → 对账。
//
//   跑法：npm run demo        只花一次真模型的钱（约 $0.00x，DEMO_MODEL 可换模型）
//   不花钱的那半：npm run demo:env   （只准备 + 体检 demo/env 这套自建环境）
//
// 它不读本机 pi 的任何设置：凭证 / 技能 / 插件都在 demo/env/ 里，
// 工作目录和产物都在 demo/work/ 里。别人装好依赖就能跑，没装 pi 也一样。
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgent, createAgentHost } from "../src/index.ts";
import { BOARD, REPORT, runCluster } from "./cluster.ts";
import {
  AGENTS_PASSPHRASE,
  ENV_DIR,
  MODEL,
  SKILL_NAME,
  SKILL_PASSPHRASE,
  WORK_DIR,
  envSpec,
  prepareEnv,
  readDemoEnv,
  under,
} from "./env.ts";
import { check, note, oneLine, say, step, summary } from "./log.ts";

// 上一轮的产物先清掉：不然陈年文件会让检查假通过
rmSync(BOARD, { force: true });
rmSync(REPORT, { force: true });

const started = Date.now();
say(`aiteam demo —— 依赖 → 自建环境 → 真模型 → agent 集群`);
say(`模型 ${MODEL} ｜ 环境 ${ENV_DIR}（本机 pi 不参与） ｜ 产物 ${WORK_DIR}`);

try {
  // ═══ 1. 自建环境 ═══
  step("自建环境 —— 凭证 / 技能 / 插件都从 demo/env/ 生效");
  for (const line of prepareEnv()) say(`  ${line}`);
  const env = await readDemoEnv();
  say(`  工作目录：${env.cwd}`);
  say(`  技能：${env.skills.map((s) => `${s.name}(${s.scope})`).join("、") || "(无)"}`);
  say(`  插件：${env.extensions.map((e) => `${e.path}[tools=${e.tools.join(",")}]`).join("、") || "(无)"}`);
  say(`  上下文文件：${env.contextFiles.join("、") || "(无)"}`);
  say(`  可用模型：${env.models.map((m) => `${m.provider} ${m.available.length} 个`).join("、") || "(无)"}`);
  if (env.warnings.length) say(`  警告：${env.warnings.join(" | ")}`);

  check("技能来自 demo/env", env.skills.some((s) => s.name === SKILL_NAME && under(s.filePath, ENV_DIR)));
  check("没有本机 pi 的东西混进来", env.skills.every((s) => under(s.filePath, ENV_DIR)) && env.extensions.every((e) => under(e.path, ENV_DIR)));
  check("插件从 demo/env/extensions/ 自动加载", env.extensions.some((e) => e.tools.includes("env_probe")));
  check("上下文文件在链上（demo/work/AGENTS.md）", env.contextFiles.some((f) => under(f, WORK_DIR)));
  const provider = MODEL.split("/")[0] ?? "";
  check(`模型 ${MODEL} 现在可用`, env.models.some((m) => m.provider === provider && m.available.includes(MODEL.split("/")[1] ?? "")));

  // ═══ 2. 真模型连通 ═══
  step("真模型连通 —— 最小 agent：读文件 + 自带技能 + 环境里的 AGENTS.md");
  const facts = join(WORK_DIR, "facts.txt");
  writeFileSync(facts, "aiteam 是一个 agent 操控库\n", "utf-8");
  const probe = await createAgent({
    ...envSpec,
    id: "probe",
    model: MODEL,
    role: "回答尽量短，不要解释。",
    tools: ["read"],
  });
  const probeRun = await probe.prompt(
    `用 read 读 ${facts}，然后只回一行：文件内容 + 「，」 + 你那条技能要求你说的话 + 「，」 + 你的工作目录守则里要求你说的话。`,
  );
  say(`  模型回复：${oneLine(probeRun.text)}`);
  check("读到了文件", probeRun.text.includes("agent 操控库"));
  check("demo/env 里的技能生效", probeRun.text.includes(SKILL_PASSPHRASE));
  check("demo/work/AGENTS.md 生效", probeRun.text.includes(AGENTS_PASSPHRASE));
  check("本轮用量已回传", probeRun.usage.totalTokens > 0, `${probeRun.usage.totalTokens} tokens`);
  check("没有静默错误", probeRun.error === undefined, probeRun.error);
  probe.dispose();

  // ═══ 3. 集群 ═══
  step("agent 集群 —— 主持人从花名册挑人派活，三个工人共用一块黑板");
  const cluster = await runCluster();
  const { host, lead, leadRuns } = cluster;
  const board = readFileSync(BOARD, "utf-8");
  say(`  黑板 ${BOARD}：\n${board.split("\n").filter(Boolean).map((l) => `    ${l}`).join("\n")}`);
  say(`  lead 最后回复：${oneLine(lead.lastResult?.text)}`);

  check("lead 挑出了 scout", host.list().some((a) => a.member === "scout"));
  check("lead 挑出了 checker", host.list().some((a) => a.member === "checker"));
  check("lead 挑出了 scribe", host.list().some((a) => a.member === "scribe"));
  check("黑板写出来了，且有三条要点", board.split("\n").filter((l) => l.startsWith("- ")).length >= 3);
  check("worker 用上了 demo/env 的插件工具 env_probe", cluster.toolCalls.includes("env_probe"), cluster.toolCalls.join(","));
  check("报告文件已落盘", readFileSync(REPORT, "utf-8").trim().length > 0, REPORT);

  // ═══ 4. 对账 ═══
  step("对账 —— 事件、用量归属、三道护栏");
  const { tool_start: starts, tool_end: ends, turn, done } = cluster.events;
  say(`  事件计数：text=${cluster.events.text} 字、tool_start=${starts}、tool_end=${ends}、turn=${turn}、done=${done}`);
  say(`  用量：宿主 ${host.usage.totalTokens} tokens / $${host.usage.cost.total.toFixed(6)}，lead 自己 ${lead.usage.totalTokens}`);
  check("tool_start 与 tool_end 成对", starts === ends && starts > 0, `${starts}/${ends}`);
  check("turn 与 done 都出现过", turn > 0 && done > 0);
  check(
    "lead.usage = 它自己各轮 RunResult 之和（不含子分身）",
    lead.usage.totalTokens === leadRuns.reduce((sum, r) => sum + r.usage.totalTokens, 0),
  );
  check("host.usage 把这棵树上所有分身都算进来了", host.usage.totalTokens > lead.usage.totalTokens);
  check("每个分身都知道自己归属哪个成员", host.list().every((a) => a.member !== undefined));

  // 护栏：预算耗尽时 createAgent 直接拒绝，不用花模型钱（maxAgents / maxDepth 同理）
  const broke = createAgentHost({ budgetTokens: 0 });
  let refused = "";
  try {
    await createAgent({ ...envSpec, model: MODEL }, { host: broke });
  } catch (err) {
    refused = String(err instanceof Error ? err.message : err);
  }
  check("护栏还在：预算耗尽时建不出新分身", /预算/.test(refused), refused);
  broke.dispose();

  const alive = host.activeCount;
  host.dispose();
  check(`host.dispose() 级联回收（${alive} 个分身）`, host.activeCount === 0);
  note("集群里的分身都保留在宿主里、可寻址，直到 dispose()");

  // ═══ 结论 ═══
  const { failed, notes } = summary();
  const spent = host.usage;
  say(`\n${"─".repeat(64)}`);
  say(failed === 0 ? "结论：库装好了，这套自建环境也是通的。" : `结论：${failed} 项硬检查没过，这个库现在还不能用。`);
  say(`全程 ${((Date.now() - started) / 1000).toFixed(1)} 秒，${spent.totalTokens} tokens ≈ $${spent.cost.total.toFixed(6)}（另有 ${notes} 项软提示）`);
  say(`产物：${BOARD}、${REPORT}、${facts}`);
  process.exit(failed === 0 ? 0 : 1);
} catch (err) {
  say(`\n✘ 跑挂了：${err instanceof Error ? err.message : String(err)}`);
  say(`  · 依赖没装好 → 在仓库根目录跑 npm install`);
  say(`  · 环境/凭证不对 → 跑 npm run demo:env 单独体检它`);
  process.exit(1);
}
