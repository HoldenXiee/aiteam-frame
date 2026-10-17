// extensions / skills 面：运行期增删扩展与技能。
//
// 机制是 **一次 reload**：桥接是常驻内联扩展，`session.reload()` 会 `_resourceLoader.reload()` +
// `_buildRuntime()`（agent-session.js:2867-2890）—— 所以「改 loader 的注入表 → reload」就能让新扩展 /
// 新技能在下一轮生效。四个注入点各走各的路（pi 的拷贝行为不同，见 src/surfaces/resources.ts 顶部）。
//
// 创建期声明的路径也落在同一张表里，所以 remove 认得出「哪些是本库显式加进来的」——环境自动发现的技能
// 不在表里，删不掉（见「environment 自动发现的技能删不掉」那条用例）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillsFromDir, SettingsManager, type AgentSession, type Skill, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildLoader } from "../src/agent/loader.ts";
import { createExtensions } from "../src/surfaces/resources.ts";
import { makeAgent, makeAgentIn, sentTools, echoTool, fauxAgentDir, fauxCwd, FAUX_MODEL_REF, faux } from "./helpers.ts";
import { createLab } from "../src/index.ts";
import { writeModelsJson } from "./faux-models.ts";

/** 造一个只含一个技能文件的临时目录；返回目录路径 */
function skillDir(name: string, description = "探路技能"): string {
  const dir = mkdtempSync(join(tmpdir(), `aiteam-${name}-`));
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`);
  return dir;
}

/** 一个只注册指定工具的扩展源码（pi 用 jiti 加载 .ts） */
function extSource(toolName: string): string {
  return `import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool(defineTool({
    name: "${toolName}",
    label: "${toolName}",
    description: "路径扩展注册的工具",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  }));
}
`;
}

/** 在 `dir` 里写一个只注册 `toolName` 的扩展，返回文件绝对路径 */
function extIn(dir: string, toolName: string): string {
  const file = join(dir, `${toolName}.ts`);
  writeFileSync(file, extSource(toolName));
  return file;
}

/** 新建临时目录并在里面写一个扩展文件，返回文件路径（R41 的「路径扩展」用） */
function extFile(toolName: string): string {
  return extIn(mkdtempSync(join(tmpdir(), `aiteam-ext-${toolName}-`)), toolName);
}

/** 把扩展放进 `<cwd>/.pi/extensions/`（pi 的**环境自动发现**路径，不由本库注入） */
function envExt(cwd: string, toolName: string): void {
  const dir = join(cwd, ".pi", "extensions");
  mkdirSync(dir, { recursive: true });
  extIn(dir, toolName);
}

/** 注册两个工具的扩展工厂：`probe_echo` + `probe_two`（R43 用 deny 只点名其中一个） */
function twoToolFactory() {
  return (pi: { registerTool: (t: ToolDefinition) => unknown }) => {
    pi.registerTool(echoTool("probe_echo") as ToolDefinition);
    pi.registerTool(echoTool("probe_two") as ToolDefinition);
  };
}

test("extensions.add(工厂)：其注册的工具出现在声明面", async () => {
  const a = await makeAgent();
  try {
    await a.extensions.add((pi) => pi.registerTool(echoTool() as ToolDefinition));
    await a.io.prompt("hi");
    assert.ok(sentTools().includes("probe_echo"));
  } finally { a.dispose(); }
});

test("extensions.list() 有 path 与它注册的工具名", async () => {
  const a = await makeAgent();
  try {
    await a.extensions.add((pi) => pi.registerTool(echoTool() as ToolDefinition));
    // 桥接也是内联扩展（`<inline:1>`，tools 为空），所以按「注册了哪个工具」定位，不能取第一个内联扩展
    const inline = a.extensions.list().find((e) => e.tools.has("probe_echo"));
    assert.ok(inline?.path.startsWith("<inline:"), `内联扩展的 path 形如 <inline:N>，实际：${inline?.path}`);
    assert.deepEqual([...(inline?.tools.keys() ?? [])], ["probe_echo"]);
  } finally { a.dispose(); }
});

test("extensions.errors() 可读：坏路径不静默", async () => {
  const a = await makeAgent({ extensions: ["/definitely/not/here.ts"] });
  try {
    const errors = a.extensions.errors();
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.error, /does not exist/);
    assert.match(errors[0]!.path, /here\.ts$/);
    assert.ok(!a.extensions.list().some((e) => /here\.ts$/.test(e.path)));   // 坏路径不会凭空变出一个扩展
  } finally { a.dispose(); }
});

test("extensions.add(路径) 与 remove(路径)：改的是库自己的注入表", async () => {
  // 钉住 R39 的路径注入点（`additionalExtensionPaths` 存引用 ⇒ push/splice 我们自己的那个数组即可）。
  // 用「不存在的路径」当探针：pi 每次 reload 都会为它产生一条 errors 记录（resource-loader.js:409-417），
  // 所以 errors 的增/减能判别「表真的改了」与「表真的改回去了」。
  const a = await makeAgent();
  const gone = join(mkdtempSync(join(tmpdir(), "aiteam-gone-")), "ext.ts");
  try {
    const before = a.extensions.errors().length;
    await a.extensions.add(gone);
    assert.equal(a.extensions.errors().length, before + 1);
    assert.match(a.extensions.errors().at(-1)!.path, /ext\.ts$/);
    await a.extensions.remove(gone);
    assert.equal(a.extensions.errors().length, before);
  } finally { a.dispose(); }
});

test("skills.add(目录)：list() 含它；remove 后消失", async () => {
  const a = await makeAgent();
  const dir = skillDir("probe-skill");
  const has = () => a.skills.list().some((s) => s.name === "probe-skill");
  try {
    assert.ok(!has());
    await a.skills.add(dir);
    assert.ok(has());
    await a.skills.remove(dir);
    assert.ok(!has());
  } finally { a.dispose(); }
});

test("skills.add 传裸技能名 → 抛错并指向 list()", async () => {
  const a = await makeAgent();
  try { await assert.rejects(() => a.skills.add("probe-skill"), /list\(\)/); } finally { a.dispose(); }
});

test("skills.add 在运行中 → 抛错（idle 守卫）", async () => {
  const a = await makeAgent();
  const dir = skillDir("probe-skill");
  try {
    const p = a.io.prompt("[[sleep:400]] slow");
    await assert.rejects(() => a.skills.add(dir), /空闲/);
    // 守卫排在**一切校验与改表之前**：忙的时候连「文件存不存在」都不该先判（否则报的是 /不存在/，
    // 设计者会以为路径写错了，而真正的原因是它现在忙）
    const bogus = { name: "bogus", description: "d", filePath: join(dir, "NOPE.md"), baseDir: dir } as Skill;
    await assert.rejects(() => a.skills.add(bogus), /空闲/);
    await p;
    // 守卫排在改表之前：被拒绝的 add 不许留下半应用状态
    assert.ok(!a.skills.list().some((s) => s.name === "probe-skill"));
  } finally { a.dispose(); }
});

test("environment 自动发现的技能删不掉（remove 只作用于显式加进来的）", async () => {
  // 用专门的 cwd：`<cwd>/.pi/skills/<name>/SKILL.md` 是 pi 的环境发现路径，不由本库注入
  const cwd = mkdtempSync(join(tmpdir(), "aiteam-env-skill-"));
  mkdirSync(join(cwd, ".pi", "skills", "env-probe"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "skills", "env-probe", "SKILL.md"),
    "---\nname: env-probe\ndescription: 环境技能\n---\n\n正文\n",
  );
  const a = await makeAgentIn(cwd);
  try {
    const env = a.skills.list().find((s) => s.name === "env-probe");
    assert.ok(env, "前提：cwd/.pi/skills 里的技能被环境自动发现");
    await assert.rejects(() => a.skills.remove(env.filePath), /显式/);
    assert.ok(a.skills.list().some((s) => s.name === "env-probe"));   // 拒绝之后它还在
  } finally { a.dispose(); }
});

test("skills.add(空目录) 不静默：抛错且不留在注入表里", async () => {
  // 与 buildLoader 对创建期技能路径的判据一致（决策 #2/#27）：表改了但什么都没加载出来，不许静默成功。
  // 第二段断言是回滚的**可观察**证据：路径若留在表里，remove 就不会说「不是显式加进来的」。
  const a = await makeAgent();
  const dir = mkdtempSync(join(tmpdir(), "aiteam-empty-"));
  try {
    await assert.rejects(() => a.skills.add(dir), /没能加载出任何技能/);
    await assert.rejects(() => a.skills.remove(dir), /显式/);
  } finally { a.dispose(); }
});

test("skills.add(Skill 对象)：运行期加的第一个也能进 list()", async () => {
  // 钉住 R39 的第四个注入点：Skill 对象只能走 `skillsOverride`（每次 reload 都调，resource-loader.js:632），
  // 而 buildLoader 若只在「创建期有 Skill 对象」时才装它，运行期加第一个就无路可走。
  const a = await makeAgent();
  const dir = skillDir("obj-skill", "对象技能");
  const [obj] = loadSkillsFromDir({ dir, source: "user" }).skills;
  const has = () => a.skills.list().some((s) => s.name === "obj-skill");
  try {
    assert.ok(obj, "前提：能从磁盘上拿到一个真的 Skill 对象");
    assert.ok(!has());
    await a.skills.add(obj!);
    assert.ok(has());
    await a.skills.remove(obj!.filePath);
    assert.ok(!has());
  } finally { a.dispose(); }
});

// ─────────────── R41：显式声明一定生效 ───────────────
// `permissions.only` 非空时 pi 会硬过滤注册表（FACTS #11），所以「本 spec / 本次 add 里显式声明的工具」
// 必须在过滤之前进白名单，否则设计者两行之内写下白名单与扩展，扩展的工具却静默无效。

test("R41 创建期：only 非空时 spec.extensions 里显式声明的内联工厂工具仍在声明面", async () => {
  const a = await makeAgent({
    permissions: { only: ["read"] },
    extensions: [(pi) => pi.registerTool(echoTool() as ToolDefinition)],
  });
  try {
    await a.io.prompt("hi");
    assert.deepEqual([...sentTools()].sort(), ["probe_echo", "read"]);
  } finally { a.dispose(); }
});

test("R41 创建期：only 非空时 spec.extensions 里显式声明的路径扩展工具仍在声明面", async () => {
  const a = await makeAgent({
    permissions: { only: ["read"] },
    extensions: [extFile("file_probe_tool")],
  });
  try {
    await a.io.prompt("hi");
    assert.deepEqual([...sentTools()].sort(), ["file_probe_tool", "read"]);
  } finally { a.dispose(); }
});

test("R41 创建期：相对扩展路径按 agent 的 cwd 解析（不是 process.cwd()）", async () => {
  // pi 把 `additionalExtensionPaths` 解成相对 **loader.cwd** 的绝对路径；比对若用 process.cwd()，
  // 「相对路径 + 不同 cwd」的显式声明就会静默匹配不上、工具被过滤掉。
  const cwd = mkdtempSync(join(tmpdir(), "aiteam-rel-ext-"));
  extIn(cwd, "rel_probe_tool");
  const a = await makeAgentIn(cwd, {
    permissions: { only: ["read"] },
    extensions: ["./rel_probe_tool.ts"],
  });
  try {
    await a.io.prompt("hi");
    assert.deepEqual([...sentTools()].sort(), ["read", "rel_probe_tool"]);
  } finally { a.dispose(); }
});

test("R41 运行期：only 非空时 extensions.add(工厂) 注册的工具并入白名单", async () => {
  const a = await makeAgent({ permissions: { only: ["read"] } });
  try {
    await a.io.prompt("hi");
    assert.deepEqual(sentTools(), ["read"]);   // 前提：白名单本来精确地只有 read
    await a.extensions.add((pi) => pi.registerTool(echoTool() as ToolDefinition));
    await a.io.prompt("hi");
    assert.deepEqual([...sentTools()].sort(), ["probe_echo", "read"]);
  } finally { a.dispose(); }
});

test("R41 运行期：only 非空时 extensions.add(路径) 注册的工具并入白名单", async () => {
  // 相对路径：同时钉住「路径认法按 agent 的 cwd 解析」（与创建期那条同一个理由）
  const cwd = mkdtempSync(join(tmpdir(), "aiteam-rel-add-"));
  extIn(cwd, "file_probe_tool");
  const a = await makeAgentIn(cwd, { permissions: { only: ["read"] } });
  try {
    await a.extensions.add("./file_probe_tool.ts");
    await a.io.prompt("hi");
    assert.deepEqual([...sentTools()].sort(), ["file_probe_tool", "read"]);
  } finally { a.dispose(); }
});

test("R41 边界：环境自动发现的扩展所注册的工具**不**并入白名单", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiteam-env-ext-"));
  envExt(cwd, "env_probe_tool");
  // 正对照：没有白名单时它确实被环境发现、工具确实注册上了（否则下面的断言是空转）
  const plain = await makeAgentIn(cwd);
  try {
    await plain.io.prompt("hi");
    assert.ok(sentTools().includes("env_probe_tool"), `前提：环境扩展没被加载：${sentTools()}`);
  } finally { plain.dispose(); }
  const only = await makeAgentIn(cwd, { permissions: { only: ["read"] } });
  try {
    await only.io.prompt("hi");
    // 并入就红了：白名单不该被环境里碰巧存在的扩展悄悄撑开（v1 `declaredExtensionToolNames` 的既定边界）
    assert.deepEqual(sentTools(), ["read"]);
  } finally { only.dispose(); }
});

// ─────────────── R42：创建期 `spec.tools.custom` 接线 ───────────────
// R41 的「来源一」（`spec.tools.custom` 的定义名并入白名单）在 R42 之前被 `NOT_WIRED` 挡着、不可达；
// 接线后它有了调用者，所以这条「前提」用例改写成它真正要钉的语义（R41 的缺口不许重新打开）。

test("R42：spec.tools.custom 的定义名并入白名单（R41 来源一现在可达）", async () => {
  const a = await makeAgent({ permissions: { only: ["read"] }, tools: { custom: [echoTool()] } });
  try {
    await a.io.prompt("hi");
    // 不并入就只剩 ["read"]：同一个 spec 里两行声明、自定义工具静默无效 —— 这条钉的就是它
    assert.deepEqual([...sentTools()].sort(), ["probe_echo", "read"]);
  } finally { a.dispose(); }
});

test("R42：工厂式 tools.custom 只调一次，且创建期就拿得到真 ctx.agent", async () => {
  let calls = 0;
  let sawAgentId: string | undefined;
  const a = await makeAgent({
    // 带上白名单：白名单里也要有工厂工具的**定义名**，而那个名字只能靠调工厂拿到 —— 这一项让
    // 「为了取名字另调一次工厂」的写法（R30b 的双跑）在这条用例里无处可藏。
    permissions: { only: ["read"] },
    tools: {
      custom: [
        (ctx) => {
          calls += 1;
          sawAgentId = ctx.agent.id;   // session 之前就被调，所以句柄必须先建、且是最终那一个
          return echoTool("probe_factory") as ToolDefinition;
        },
      ],
    },
  });
  try {
    assert.equal(calls, 1, "工厂只该被调一次");
    assert.equal(sawAgentId, a.id, "ctx.agent 必须是最终那个 agent 句柄（不是空壳副本）");
    await a.io.prompt("hi");
    assert.deepEqual([...sentTools()].sort(), ["probe_factory", "read"]);
    assert.equal(calls, 1, "跑完一轮工厂也不该被再调一次（R30b：存成品，不存工厂）");
  } finally { a.dispose(); }
});

// ─────────────── R43：越具体的声明越强 —— deny 压过 R41 的并入 ───────────────
// 同一个 spec 里 `permissions.deny: ["x"]` 而扩展又注册了 `x` 时，排除集压过并入（pi 的
// `isAllowedTool = 白名单放行 && !排除集`，agent-session.js:2748）。扩展**同时**注册一个没被点名的工具，
// 保证这条用例钉的是「deny 生效」而不是「整个扩展被并坏了」。

test("R43 创建期：deny 压过 R41 并入（被点名的工具仍被排除，同扩展的另一个工具照常生效）", async () => {
  const a = await makeAgent({
    permissions: { only: ["read"], deny: ["probe_echo"] },
    extensions: [twoToolFactory()],
  });
  try {
    await a.io.prompt("hi");
    // probe_echo 被 deny 点名 → 不在；probe_two 走 R41 并入 → 在。若并入把 deny 覆盖了（allow 式
    // `_excludedToolNames.delete`），probe_echo 会重新出现、这条变红。
    assert.deepEqual([...sentTools()].sort(), ["probe_two", "read"]);
  } finally { a.dispose(); }
});

// ─────────────── R44：更晚的显式声明胜 —— 运行期 extensions.add 同时摘排除集 ───────────────
// R43 只管「同一份 spec 内」并列时的具体性（上面那条创建期用例，deny 胜，别动）。
// 但「创建期 deny + 更晚的 extensions.add」曾被判 deny 仍胜，而「运行期 deny（有白名单 ⇒ 只摘白名单、
// 不写排除集）+ 更晚的 add」却是 add 胜 —— 同一个逻辑情形因 deny 来源不同而结果相反。
// R44 按时间规则统一成 add 胜（与 tools.add 的 R37 对称），下面三个分量断言它们取值一致。

test("R44：更晚的 extensions.add 覆盖创建期的 deny（与运行期 deny 的结果一致）", async () => {
  const declared = await makeAgent({ permissions: { only: ["read"], deny: ["probe_echo"] } });
  try {
    await declared.io.prompt("hi");
    assert.deepEqual(sentTools(), ["read"], "前提：创建期 deny 本来把 probe_echo 挡在门外");
    await declared.extensions.add(twoToolFactory());
    await declared.io.prompt("hi");
    // R44 之前这里是 ["probe_two", "read"]（probe_echo 被排除集硬过滤）—— 这条分量改前必红
    assert.deepEqual([...sentTools()].sort(), ["probe_echo", "probe_two", "read"]);
  } finally { declared.dispose(); }

  // 对照分量：deny 来自运行期（有白名单 ⇒ 只摘白名单名、不写排除集）时，更晚的 add 一向是 add 胜。
  const runtime = await makeAgent({ permissions: { only: ["read"] } });
  try {
    await runtime.permissions.deny(["probe_echo"]);
    await runtime.extensions.add(twoToolFactory());
    await runtime.io.prompt("hi");
    assert.deepEqual([...sentTools()].sort(), ["probe_echo", "probe_two", "read"]);
  } finally { runtime.dispose(); }

  // 第三分量：**无白名单**时排除集同样要被摘掉（`_allowedToolNames` 为 undefined 的那条分支，
  // 实现里若在没白名单时提前 return，就只有这一分量会红）。
  const noWhitelist = await makeAgent({ permissions: { deny: ["probe_echo"] } });
  try {
    await noWhitelist.io.prompt("hi");
    assert.ok(!sentTools().includes("probe_echo"), "前提：创建期 deny 把它挡在门外");
    await noWhitelist.extensions.add(twoToolFactory());
    await noWhitelist.io.prompt("hi");
    assert.ok(sentTools().includes("probe_echo"));
  } finally { noWhitelist.dispose(); }
});

// ─────────────── remove 的路径基准 = agent 的 cwd（与 declaredExtensionToolNames 同一口径） ───────────────
// pi 把注入路径解成相对 loader.cwd 的绝对路径，而库里存的是设计者原样给的字符串（可能是 "./x"）。
// 比对若用 process.cwd()，`cwd ≠ 进程 cwd` 时「相对 add + 绝对 remove」会误报「不是显式加进来的」。

test("extensions.remove 的基准是 agent 的 cwd：相对 add + 绝对 remove 能对上", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiteam-cwd-ext-"));
  extIn(cwd, "cwd_probe_tool");
  const abs = join(cwd, "cwd_probe_tool.ts");
  const a = await makeAgentIn(cwd);
  try {
    await a.extensions.add("./cwd_probe_tool.ts");
    await a.extensions.remove(abs);
    // 第二次 remove 必须报「不是显式加进来的」——证明第一次是真的摘掉了，不是碰巧没抛错
    await assert.rejects(() => a.extensions.remove(abs), /不是本库显式加进来的/);
  } finally { a.dispose(); }
});

test("skills.add(相对路径) 基准是 agent 的 cwd（校验不误报「没加载出技能」）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiteam-cwd-skill-"));
  mkdirSync(join(cwd, "skills", "rel-skill"), { recursive: true });
  writeFileSync(
    join(cwd, "skills", "rel-skill", "SKILL.md"),
    "---\nname: rel-skill\ndescription: 相对技能\n---\n\n正文\n",
  );
  const a = await makeAgentIn(cwd);
  try {
    // 只钉 add 侧的校验基准（remove 的基准由下一条用例单独钉）
    await a.skills.add("./skills/rel-skill");
    assert.ok(a.skills.list().some((s) => s.name === "rel-skill"));
  } finally { a.dispose(); }
});

test("skills.remove(相对路径) 基准是 agent 的 cwd：绝对 add + 相对 remove 能对上", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiteam-cwd-skill-rm-"));
  mkdirSync(join(cwd, "skills", "rel-skill"), { recursive: true });
  writeFileSync(
    join(cwd, "skills", "rel-skill", "SKILL.md"),
    "---\nname: rel-skill\ndescription: 相对技能\n---\n\n正文\n",
  );
  const a = await makeAgentIn(cwd);
  try {
    await a.skills.add(join(cwd, "skills", "rel-skill"));
    assert.ok(a.skills.list().some((s) => s.name === "rel-skill"));
    await a.skills.remove("./skills/rel-skill/SKILL.md");   // 目录 add、按 SKILL.md 文件路径 remove（走 under）
    assert.ok(!a.skills.list().some((s) => s.name === "rel-skill"));
  } finally { a.dispose(); }
});

test("创建期相对技能路径按 agent 的 cwd 解析（不是 process.cwd()）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiteam-decl-skill-"));
  mkdirSync(join(cwd, "skills", "decl-skill"), { recursive: true });
  writeFileSync(
    join(cwd, "skills", "decl-skill", "SKILL.md"),
    "---\nname: decl-skill\ndescription: 声明技能\n---\n\n正文\n",
  );
  // 修之前 buildLoader 会抛「技能路径没能加载出任何技能」—— pi 明明按 loader.cwd 加载到了，
  // 本库的校验却按 process.cwd() 比对（同一个基准 bug）。
  const a = await makeAgentIn(cwd, { skills: ["./skills/decl-skill"] });
  try {
    assert.ok(a.skills.list().some((s) => s.name === "decl-skill"));
  } finally { a.dispose(); }
});

// ─────────────── 第二趟 reload 失败必须回滚第一趟 ───────────────

test("extensions.add 第二趟 reload 失败 → 注入表回滚，不留半应用状态", async () => {
  // R41 的双趟 reload 只在「有白名单 + 这次真有新工具名」时跑第二趟。第二趟失败时若只摘白名单名、
  // 不回滚第一趟的 push，扩展就留在注入表里（下次 reload 还会被带进来），而调用方拿到的是异常 ——
  // 与 skills.add(路径) 校验失败即回滚自相矛盾。
  // 真实的 `session.reload()` 没法在第二次稳定抛错，所以这里直连 `createExtensions`，把 bridge.reload
  // 换成「第一趟真 reload、第二趟抛错」的桩 —— 被测的是 resources.ts 的回滚，不是 pi。
  const loader = await buildLoader({}, {
    cwd: fauxCwd,
    agentDir: fauxAgentDir,
    settingsManager: SettingsManager.inMemory(),
  });
  const allowed = new Set(["read"]);
  let reloads = 0;
  const factories = () => (loader as unknown as { extensionFactories: unknown[] }).extensionFactories;
  const ext = createExtensions({
    loader,
    session: { _allowedToolNames: allowed } as unknown as AgentSession,
    bridge: {
      reload: async () => {
        reloads += 1;
        if (reloads === 2) throw new Error("第二趟 reload 炸了");
        await loader.reload();
      },
    },
    isBusy: () => false,
    assertAlive: () => {},
  });
  assert.equal(factories().length, 0, "前提：还没加任何内联工厂");
  await assert.rejects(() => ext.add(twoToolFactory()), /第二趟 reload 炸了/);
  assert.equal(reloads, 2, "前提：确实跑到了第二趟 reload");
  assert.equal(factories().length, 0, "第一趟 push 的工厂要撤回去（半应用状态）");
  assert.deepEqual([...allowed], ["read"], "并入的白名单名也要摘回去");
});

// ─────────────── R48：skills / extensions 的精确白名单 ───────────────
//
// 语义三档（与 permissions.only 同构）：不写 = 环境全给；写了 = 就这些；`[]` = 一个都没有。
// 白名单只裁**环境自动发现**的那部分（base），不裁注入表 —— 所以运行期 add 照常生效。
//
// 判别力：这些用例在实现之前**必须红**（旧语义下 base 无条件全进）。

/** 一个临时 cwd：`.pi/skills/<name>/SKILL.md` 是 pi 的环境发现路径 */
function cwdWithEnvSkills(names: string[]): string {
  const cwd = mkdtempSync(join(tmpdir(), "aiteam-env-skills-"));
  for (const n of names) {
    const dir = join(cwd, ".pi", "skills", n);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${n}\ndescription: 环境技能\n---\n\n正文\n`);
  }
  return cwd;
}

test("R48：skills 不写 → 环境自动发现的技能全给（向后兼容）", async () => {
  const a = await makeAgentIn(cwdWithEnvSkills(["env-a", "env-b"]));
  try {
    const names = a.skills.list().map((s) => s.name).filter((n) => n.startsWith("env-"));
    assert.deepEqual(names.sort(), ["env-a", "env-b"]);
  } finally { a.dispose(); }
});

test("R48：skills 写了 → 精确：环境里没写进来的不进这个 agent", async () => {
  const a = await makeAgentIn(cwdWithEnvSkills(["env-a", "env-b"]), { skills: ["env-a"] });
  try {
    const names = a.skills.list().map((s) => s.name);
    assert.ok(names.includes("env-a"), "写进来的要在");
    assert.ok(!names.includes("env-b"), "没写进来的要被裁掉 —— 旧语义下它会无条件跟着环境进来");
  } finally { a.dispose(); }
});

test("R48：skills: [] → 一个技能都没有", async () => {
  const a = await makeAgentIn(cwdWithEnvSkills(["env-a", "env-b"]), { skills: [] });
  try {
    assert.deepEqual(a.skills.list().map((s) => s.name), []);
  } finally { a.dispose(); }
});

test("R48：技能名解析不到 → 抛错（白名单是精确的，写错必须响）", async () => {
  await assert.rejects(
    () => makeAgentIn(cwdWithEnvSkills(["env-a"]), { skills: ["nope"] }),
    /找不到技能「nope」/,
  );
});

test("R48：extensions 不写 → 环境扩展全给；写了 → 只留声明的那个", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiteam-env-exts-"));
  const dir = join(cwd, ".pi", "extensions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "env-a.ts"), extSource("env_tool_a"));
  writeFileSync(join(dir, "env-b.ts"), extSource("env_tool_b"));

  const all = await makeAgentIn(cwd);
  try {
    const tools = all.io.raw.getActiveToolNames();
    assert.ok(tools.includes("env_tool_a") && tools.includes("env_tool_b"), "不写时环境扩展全给");
  } finally { all.dispose(); }

  const onlyA = await makeAgentIn(cwd, { extensions: [join(dir, "env-a.ts")] });
  try {
    const tools = onlyA.io.raw.getActiveToolNames();
    assert.ok(tools.includes("env_tool_a"), "声明的要在");
    assert.ok(!tools.includes("env_tool_b"), "没声明的扩展连工具都不该注册进来");
  } finally { onlyA.dispose(); }
});

test("R48：extensions: [] → 环境扩展一个都不加载，但库的桥接还在", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiteam-env-exts-"));
  const dir = join(cwd, ".pi", "extensions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "env-a.ts"), extSource("env_tool_a"));

  const a = await makeAgentIn(cwd, { extensions: [] });
  try {
    assert.ok(!a.io.raw.getActiveToolNames().includes("env_tool_a"));
    // 桥接（`<inline:1>`）不许被裁：裁掉它等于把工具表/事件接线一起拆了
    assert.ok(a.extensions.list().some((e) => e.path === "<inline:1>"), "库的桥接扩展必须永远在");
    // 会话仍可用：`read` 这类 pi 自带工具与库的接线都不受扩展白名单影响
    assert.ok(a.io.raw.getActiveToolNames().includes("read"));
  } finally { a.dispose(); }
});

test("R48：白名单只裁环境发现，不裁运行期 add（与 only 后再 allow 同理）", async () => {
  const cwd = cwdWithEnvSkills(["env-a", "env-b"]);
  const a = await makeAgentIn(cwd, { skills: [] });
  const dir = skillDir("runtime-skill");
  try {
    assert.deepEqual(a.skills.list().map((s) => s.name), [], "前提：白名单是空的");
    await a.skills.add(dir);
    assert.ok(a.skills.list().some((s) => s.name === "runtime-skill"), "运行期 add 不受创建期白名单限制");
  } finally { a.dispose(); }
});

/** 一个自带假 provider 配置的临时 agentDir（R49 用例要自定义环境目录，不能复用 fauxAgentDir） */
function ownAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aiteam-bound-agent-"));
  writeModelsJson(dir, faux.baseUrl);
  return dir;
}

// ─────────────── R49：实验室边界（环境 = {agentDir} ∪ {cwd 子树}）───────────────
//
// 判据来自 DESIGN.md：「必须使用自定义的环境，电脑中的 pi Agent 的环境是不能使用的」。
// pi 的 DefaultResourceLoader 默认会**往上游、往宿主找**（cwd 祖先链的 AGENTS.md、
// $HOME/.agents/skills、git 根一路上去的 .agents/skills），这些都实验室从未声明。
//
// 判别力：这些用例在 R49 之前必须红。

test("R49：cwd 祖先目录的 AGENTS.md 不进系统提示词，cwd 自己的保留", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-bound-"));
  const agentDir = ownAgentDir();
  const cwd = join(root, "sub", "work");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "ANCESTOR-BOUNDARY-MARKER\n");
  writeFileSync(join(cwd, "AGENTS.md"), "CWD-BOUNDARY-MARKER\n");

  const a = await (await createLab({ agentDir, cwd, modelNetwork: false })).createAgent({ model: FAUX_MODEL_REF });
  try {
    const sys = a.io.raw.systemPrompt;
    assert.ok(!sys.includes("ANCESTOR-BOUNDARY-MARKER"), "实验室外的祖先 AGENTS.md 不该进 system");
    assert.ok(sys.includes("CWD-BOUNDARY-MARKER"), "cwd 自己的 AGENTS.md 属实验室范围，要保留");
  } finally { a.dispose(); }
});

test("R49：祖先目录的 .agents/skills 不进实验室，cwd 子树内的保留", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-bound-"));
  const agentDir = ownAgentDir();
  const hostProj = join(root, "hostproj");
  const cwd = join(hostProj, "sub", "work");
  mkdirSync(cwd, { recursive: true });

  // 实验室外：祖先项目的 .agents/skills（pi 的 collectAncestorAgentsSkillDirs 会收）
  const outside = join(hostProj, ".agents", "skills", "outside-skill");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "SKILL.md"), "---\nname: outside-skill\ndescription: d\n---\n\nb\n");
  // 实验室内：cwd 子树的 .pi/skills
  const inside = join(cwd, ".pi", "skills", "inside-skill");
  mkdirSync(inside, { recursive: true });
  writeFileSync(join(inside, "SKILL.md"), "---\nname: inside-skill\ndescription: d\n---\n\nb\n");

  const a = await (await createLab({ agentDir, cwd, modelNetwork: false })).createAgent({ model: FAUX_MODEL_REF });
  try {
    const names = a.skills.list().map((s) => s.name);
    assert.ok(!names.includes("outside-skill"), "祖先 .agents/skills 是实验室外的，不该进来");
    assert.ok(names.includes("inside-skill"), "cwd 子树内的技能属实验室范围");
  } finally { a.dispose(); }
});

test("R49：agentDir/prompts 的模板不加载（模板正文本来会随 prompt 展开发给模型）", async () => {
  const agentDir = ownAgentDir();
  mkdirSync(join(agentDir, "prompts"), { recursive: true });
  writeFileSync(join(agentDir, "prompts", "leaky.md"), "---\nname: leaky\ndescription: d\n---\nLEAKY_BODY\n");

  const a = await (await createLab({ agentDir, cwd: fauxCwd, modelNetwork: false })).createAgent({ model: FAUX_MODEL_REF });
  try {
    const templates = (a.io.raw as unknown as { promptTemplates?: unknown[] }).promptTemplates ?? [];
    assert.equal(templates.length, 0, "模板默认不该加载（要就自己拼提示词）");
  } finally { a.dispose(); }
});

test("R49：agentDir/APPEND_SYSTEM.md 生效，不再被恒传的空数组静默吃掉", async () => {
  const agentDir = ownAgentDir();
  writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "APPEND-BOUNDARY-MARKER\n");

  const lab = await createLab({ agentDir, cwd: fauxCwd, modelNetwork: false });
  const a = await lab.createAgent({ model: FAUX_MODEL_REF });
  try {
    assert.ok(a.io.raw.systemPrompt.includes("APPEND-BOUNDARY-MARKER"), "环境的 APPEND_SYSTEM.md 该进 system");
    const files = (await lab.inspectEnv()).appendSystemPromptFiles;
    assert.ok(files.some((f) => f.endsWith("APPEND_SYSTEM.md")), "inspectEnv 也要报出它（旧的零信号）");
  } finally { a.dispose(); }
});

test("R49：role 与环境 APPEND_SYSTEM.md 并存，互不挤掉", async () => {
  const agentDir = ownAgentDir();
  writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "APPEND-BOTH-MARKER\n");

  const a = await (await createLab({ agentDir, cwd: fauxCwd, modelNetwork: false }))
    .createAgent({ model: FAUX_MODEL_REF, role: "ROLE-BOTH-MARKER" });
  try {
    const sys = a.io.raw.systemPrompt;
    assert.ok(sys.includes("APPEND-BOTH-MARKER"), "环境的那份要在");
    assert.ok(sys.includes("ROLE-BOTH-MARKER"), "role 也要在（旧实现在这条分支上把环境那份挤掉了）");
  } finally { a.dispose(); }
});
