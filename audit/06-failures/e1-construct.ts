// 6.1 构造期失败模式全表 + 每种失败的原始错误串 + 「静默通过」的验证。
// 跑法：node audit/06-failures/e1-construct.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { SettingsManager, defineTool, DefaultResourceLoader, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgent, createAgentHost } from "../../src/index.ts";
import { check, dump, record, section } from "../_harness.ts";
import { makeEnv, makeExtension, makeSkill } from "../_faux.ts";
import { raw, save } from "./_d.ts";

const env = await makeEnv();
const { agentDir, cwd, runtime, model, root } = env;

const mk = (extra: Record<string, unknown> = {}, deps: Record<string, unknown> = {}) =>
  createAgent({ model, cwd, agentDir, ...extra } as never, { modelRuntime: runtime, ...deps } as never);

const echoTool = defineTool({
  name: "probe_echo",
  label: "probe",
  description: "回显",
  parameters: Type.Object({ text: Type.Optional(Type.String()) }),
  execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
});

interface Row {
  id: string;
  what: string;
  how: "抛错" | "成功";
  error?: string;
}
const rows: Row[] = [];
async function construct(id: string, what: string, run: () => Promise<unknown>): Promise<void> {
  let how: Row["how"] = "成功";
  let error: string | undefined;
  try {
    await run();
  } catch (e) {
    how = "抛错";
    error = raw(e);
  }
  rows.push({ id, what, how, ...(error ? { error } : {}) });
  console.log(`   ${id} ${what} → ${how}${error ? `\n        ${error.split("\n")[0]}` : ""}`);
}

section("6.1 构造期失败模式（每条都贴原始错误串）");

makeSkill(agentDir, "dup", "重复技能", "正文"); // 名字解析走 agentDir/skills 发现路径

await construct("c01", "model 指向不存在的模型", () => mk({ model: "faux/不存在" }));
await construct("c02", "model 指向不存在的 provider", () => mk({ model: "没这个provider/x" }));
await construct("c03", "skills 名字不存在", () => mk({ skills: ["不存在技能"] }));
await construct("c04", "Skill 对象 filePath 不存在", () =>
  mk({ skills: [{ name: "x", description: "d", filePath: join(root, "no", "SKILL.md"), baseDir: root, source: "custom" }] }),
);
await construct("c05", "extensions 路径不存在", () => mk({ extensions: [join(root, "无此扩展.ts")] }));
await construct("c06", "extensions 文件语法错误", async () => {
  const bad = join(root, "bad-ext.ts");
  writeFileSync(bad, "export default function (pi) { this is not valid typescript (((\n", "utf-8");
  return mk({ extensions: [bad] });
});
await construct("c07", "extensions 内联工厂自己抛错", () => mk({ extensions: [() => { throw new Error("内联扩展工厂炸了-EXT"); }] }));
await construct("c08", "cwd 目录不存在", () => mk({ cwd: join(root, "没有这个目录") }));
await construct("c09", "agentDir 目录不存在（显式传 runtime）", () => mk({ agentDir: join(root, "没有这个 agentDir") }));
await construct("c09b", "agentDir 目录不存在（不传 runtime）", () => createAgent({ model, cwd, agentDir: join(root, "没有这个 agentDir") } as never));
await construct("c10", "agentDir 指向一个普通文件", () => {
  const f = join(root, "这是文件不是目录.txt");
  writeFileSync(f, "x", "utf-8");
  return mk({ agentDir: f });
});
await construct("c11", "agentDir 里的 models.json 是坏 JSON（显式传了 runtime）", () => {
  const d = join(root, "broken-json");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "models.json"), "{ 这不是 JSON", "utf-8");
  return mk({ agentDir: d });
});
await construct("c12", "agentDir 里的 models.json 是坏 JSON 且不传 runtime", () => {
  const d = join(root, "broken-json2");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "models.json"), "{ 这不是 JSON", "utf-8");
  return createAgent({ model, cwd, agentDir: d } as never);
});
await construct("c13", "tools 里含不存在的工具名", () => mk({ tools: ["read", "根本不存在的工具"] }));
await construct("c14", "excludeTools 拼错名字", () => mk({ tools: ["read"], excludeTools: ["reed"] }));
await construct("c15", "customTools 提供了但没列进 tools", () => mk({ customTools: [echoTool] }));
await construct("c16", "model 的 thinking 档位非法", () => mk({ model: `${model}:ultra` }));
await construct("c17", "重复的 agent id", async () => {
  const host = createAgentHost({ modelRuntime: runtime, defaults: { model, cwd, agentDir } } as never);
  await createAgent({ id: "same" }, { host, modelRuntime: runtime } as never);
  return createAgent({ id: "same" }, { host, modelRuntime: runtime } as never);
});
await construct("c18", "provider 端口没人听：构造期会不会发现", async () => {
  const d = join(root, "dead-port");
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "models.json"),
    JSON.stringify({ providers: { dead: { name: "dead", baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "k", models: [{ id: "ghost", name: "ghost", reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }] } } }),
    "utf-8",
  );
  const rt = await ModelRuntime.create({ modelsPath: join(d, "models.json"), allowModelNetwork: false });
  return createAgent({ model: "dead/ghost", cwd, agentDir: d } as never, { modelRuntime: rt } as never);
});
await construct("c19", "手动传的 modelRuntime 与 spec.model 对不上", async () => {
  const d = join(root, "other-models");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "models.json"), JSON.stringify({ providers: {} }), "utf-8");
  const rt = await ModelRuntime.create({ modelsPath: join(d, "models.json"), allowModelNetwork: false });
  return createAgent({ model, cwd, agentDir: d } as never, { modelRuntime: rt } as never);
});
await construct("c20", "skills 里同一个名字写两遍（技能真实存在）", () => mk({ skills: ["dup", "dup"] }));
await construct("c21", "不传 model（留给全局默认）", () => mk({ model: undefined }));

record({
  id: "6.1a",
  question: "构造期有哪些输入会失败、失败通道是什么",
  observed: rows.map((r) => `${r.id} ${r.what} = ${r.how}`).join("；"),
  verdict: "GAP",
  conclusion:
    `21 组构造输入里 **${rows.filter((r) => r.how === "成功").length} 组静默成功**（` +
    rows.filter((r) => r.how === "成功").map((r) => r.id).join(",") +
    `）。抛错的全是自由文本、没有错误码；错误前言与真实原因还会打架（c01 说「解析有警告」，真实原因是「Model not found … Using custom model id」）。构造期完全离线：provider 端口没人听（c18）构造成功，直到第一次 prompt 才炸。`,
  data: rows,
});

// ───────── 静默成功的那几条：实际生效了吗（ground truth = 假服务收到的 tools） ─────────
section("6.1b 静默通过的配置：实际生效了吗（ground truth = 模型收到的 tools）");

const probeRows: Array<{ id: string; what: string; intent: string; actual: string[]; silent: boolean }> = [];
async function probe(id: string, what: string, spec: Record<string, unknown>, intent: string[] | "默认不指定"): Promise<void> {
  const before = env.calls().length;
  const a = await mk(spec);
  await a.prompt("hi");
  const actual = env.calls()[before]?.tools ?? [];
  a.dispose();
  const silent = intent !== "默认不指定" && [...intent].sort().join(",") !== [...actual].sort().join(",");
  probeRows.push({ id, what, intent: intent === "默认不指定" ? intent : intent.join(","), actual, silent });
  console.log(`   ${id} ${what}\n        意图 = ${intent === "默认不指定" ? intent : JSON.stringify(intent)}　实际 = ${JSON.stringify(actual)}　${silent ? "← 不一致（静默）" : "一致"}`);
}

const goodExt = makeExtension(root, "good-ext.ts", "ext_probe_tool");
await probe("p01", "不给 tools（默认工具集）", {}, "默认不指定");
await probe("p02", "tools 里拼错一个工具名", { tools: ["read", "根本不存在的工具"] }, ["read", "根本不存在的工具"]);
await probe("p03", "excludeTools 拼错", { tools: ["read", "bash"], excludeTools: ["reed"] }, ["read", "bash"]);
await probe("p04", "excludeTools 拼对（对照）", { tools: ["read", "bash"], excludeTools: ["bash"] }, ["read"]);
await probe("p05a", "customTools 提供 + 不给 tools", { customTools: [echoTool] }, ["probe_echo", "read", "bash", "edit", "write"]);
await probe("p05b", "customTools 提供 + tools 白名单里没写它", { customTools: [echoTool], tools: ["read"] }, ["read"]);
await probe("p06a", "extensions 指向一个有效扩展（正对照）", { extensions: [goodExt] }, ["ext_probe_tool", "read", "bash", "edit", "write"]);
await probe("p06b", "extensions 路径不存在", { extensions: [join(root, "无此扩展.ts")] }, ["read", "bash", "edit", "write", "ext_probe_tool"]);
await probe("p07", "tools 白名单点名了有效扩展工具", { extensions: [goodExt], tools: ["ext_probe_tool"] }, ["ext_probe_tool"]);
await probe("p08", "tools: []", { tools: [] }, []);
await probe("p09", "excludeTools 排掉一个 customTool（名字对）", { customTools: [echoTool], tools: ["probe_echo"], excludeTools: ["probe_echo"] }, []);

record({
  id: "6.1b",
  question: "构造期静默通过的配置项，实际生效情况如何",
  observed: probeRows.map((r) => `${r.id} ${r.what}：意图=${r.intent} 实际=${JSON.stringify(r.actual)}${r.silent ? "（≠意图，静默无效）" : ""}`).join("；"),
  verdict: "GAP",
  conclusion:
    "拼错工具名（p02）被静默丢弃；excludeTools 拼错（p03）静默无效；customTools 在白名单存在但没列它时（p05b）静默不挂载（不给白名单时 p05a 反而挂载 —— 白名单是唯一的开关）；extensions 路径写错（p06b）静默不加载，而有效扩展（p06a/p07）正常。四类都是「设计者以为配上了，运行时不生效且无任何信号」。",
  data: probeRows,
});

// ───────── 扩展加载失败的 error 其实存在，只是被吞了 ─────────
section("6.1c 资源加载器明明有结构化错误，库把它吞了");

{
  const mkLoader = (exts: string[]) =>
    new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: exts,
    });
  const out: Array<{ ext: string; extensions: string[]; errors: string[]; warnings: string[] }> = [];
  const badExt = join(root, "bad-ext-2.ts");
  writeFileSync(badExt, "export default function (pi) { this is not valid (((\n", "utf-8");
  for (const ext of [goodExt, badExt, join(root, "无此扩展.ts")]) {
    const loader = mkLoader([ext]);
    await loader.reload();
    const g = loader.getExtensions() as unknown as { extensions: Array<{ path: string; tools: Map<string, unknown> }>; errors: Array<{ path: string; error: string }>; warnings: unknown[] };
    out.push({ ext: ext.replace(root, "<root>"), extensions: g.extensions.map((e) => e.path.replace(root, "<root>")), errors: (g.errors ?? []).map((e) => `${e.path.replace(root, "<root>")}: ${e.error}`), warnings: (g.warnings ?? []).map(String) });
  }
  record({
    id: "6.1c",
    question: "扩展加载失败的信息存在于哪里、库有没有用它",
    observed: out.map((o) => `${o.ext} → 已加载=${JSON.stringify(o.extensions)} errors=${JSON.stringify(o.errors)}`).join("；"),
    verdict: "GAP",
    conclusion:
      "`loader.getExtensions()` 返回 `{ extensions, errors, warnings }`，扩展路径不存在与语法错误的**完整原因都在 `errors` 里**（例：`Extension path does not exist: …` / `Failed to load extension: ParseError: …`）。但 `buildLoader()` 只读 `.extensions`（`declaredExtensionToolNames`），**`errors` 与 `warnings` 从不被读取** —— 所以扩展加载失败变成了构造期静默通过。修复只需读一下这个字段，但当下设计者拿不到。",
    data: out,
  });
}

// ───────── 空花名册时的 spawn_agent ─────────
section("6.1d 白名单点了库工具但前置条件缺失");

{
  const before = env.calls().length;
  const a = await mk({ tools: ["spawn_agent"] });
  const seen = env.calls()[before]?.tools ?? [];
  const noHost = await a.prompt("[[tool:spawn_agent]] [[args:{\"member\":\"x\",\"task\":\"y\"}]]");
  a.dispose();
  record({
    id: "6.1d1",
    question: "tools 里点了 spawn_agent 但没有 host，会怎样",
    observed: `模型看到的工具 = ${JSON.stringify(seen)}；调用后 error=${JSON.stringify(noHost.error ?? null)} text=${JSON.stringify(noHost.text.slice(0, 120))}`,
    verdict: "GAP",
    conclusion:
      "工具被挂上（库工具不要求 host），但空花名册让参数 schema 成了 `Type.Never` —— 任何调用都在**参数校验阶段**被拒，模型看到的是 `Validation failed for tool \"spawn_agent\": - member: must not be valid`。「花名册是空的」这句话永远不会被执行到（execute 只在参数合法时进入）。设计者得到的是一个语法层错误，而不是「你没配 members」。",
    data: { seen, error: noHost.error ?? null, text: noHost.text.slice(0, 300) },
  });
}

{
  // 有 host 但花名册为空
  const host = createAgentHost({ modelRuntime: runtime, defaults: { model, cwd, agentDir } } as never);
  const a = await createAgent({ tools: ["spawn_agent"] }, { host, modelRuntime: runtime } as never);
  const r = await a.prompt("[[tool:spawn_agent]] [[args:{\"member\":\"x\",\"task\":\"y\"}]]");
  record({
    id: "6.1d2",
    question: "有 host 但 members 为空时，模型看到什么",
    observed: `error=${JSON.stringify(r.error ?? null)} text=${JSON.stringify(r.text.slice(0, 200))}`,
    verdict: "GAP",
    conclusion: "同样是参数校验失败（`must not be valid`），工具描述里写的是「（花名册是空的）」。设计者能读到的唯一线索是模型看到的原始校验文本。",
    data: { error: r.error ?? null, text: r.text.slice(0, 300) },
  });
  a.dispose();
  host.dispose();
}

// ───────── 构造失败会不会留下登记残留 ─────────
{
  const host = createAgentHost({ modelRuntime: runtime, defaults: { model: "faux/不存在", cwd, agentDir }, maxAgents: 4 } as never);
  const results: string[] = [];
  for (let i = 0; i < 3; i++) {
    try {
      await createAgent({}, { host, modelRuntime: runtime } as never);
      results.push(`${i}: 成功`);
    } catch (e) {
      results.push(`${i}: 抛错「${(e as Error).message.slice(0, 30)}」`);
    }
  }
  record({
    id: "6.1e",
    question: "反复构造失败会不会吃满 maxAgents（登记残留）",
    observed: `三次构造失败（每次都用不存在的模型）：${results.join("；")}；失败后 host.activeCount=${host.activeCount}，host 仍可用=${host.activeCount === 0}`,
    verdict: host.activeCount === 0 ? "OK" : "GAP",
    conclusion: host.activeCount === 0 ? "无残留：构造失败的分身没有进登记表，maxAgents 不会被吃。" : "有残留：构造失败也占用了 maxAgents 名额。",
    data: { results, activeCount: host.activeCount },
  });
  host.dispose();
}

save("e1", { rows, probeRows });
dump("06-failures-e1");
await env.close();
