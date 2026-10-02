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
import { loadSkillsFromDir, type Skill, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { makeAgent, sentTools, echoTool } from "./helpers.ts";

/** 造一个只含一个技能文件的临时目录；返回目录路径 */
function skillDir(name: string, description = "探路技能"): string {
  const dir = mkdtempSync(join(tmpdir(), `aiteam-${name}-`));
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`);
  return dir;
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
  const a = await makeAgent({ cwd });
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
