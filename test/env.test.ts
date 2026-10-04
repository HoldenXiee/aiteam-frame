// 验证语句：inspectEnv 报出的东西，必须与实际生效的东西一致。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLab } from "../src/index.ts";
import { fauxAgentDir } from "./helpers.ts";

function makeSkill(root: string, name: string): void {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n正文\n`, "utf-8");
}

function makeExtension(root: string, toolName: string): void {
  const dir = join(root, "extensions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "probe-ext.ts"),
    `export default function (pi) {
  pi.registerTool({ name: "${toolName}", label: "${toolName}", description: "探针",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
}\n`,
    "utf-8",
  );
}

test("报出可用模型、技能、扩展（含扩展偷偷注册的工具名）", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-env-"));
  makeSkill(fauxAgentDir, "env-skill");
  makeExtension(fauxAgentDir, "env_ext_tool");

  const report = await (await createLab({ agentDir: fauxAgentDir, cwd: root, modelNetwork: false })).inspectEnv();

  const faux = report.models.find((m) => m.provider === "faux");
  assert.ok(faux, "没报出 faux provider");
  assert.ok(faux.available.length > 0);

  assert.deepEqual(
    report.skills.map((s) => [s.name, s.scope]),
    [["env-skill", "user"]],
  );
  const ext = report.extensions.find((e) => e.path.includes("probe-ext.ts"));
  assert.ok(ext, "没报出环境里自动发现的扩展");
  assert.deepEqual(ext.tools, ["env_ext_tool"]);
  assert.equal(ext.scope, "user");
});

test("空目录：三样都是空的，且把「为什么空」讲出来", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-env-empty-"));
  const report = await (await createLab({ agentDir: join(root, "nothing-here"), cwd: root, modelNetwork: false })).inspectEnv();

  assert.deepEqual(report.skills, []);
  assert.deepEqual(report.extensions, []);
  assert.deepEqual(report.contextFiles, []);
  assert.equal(report.systemPromptFile, undefined);
  assert.ok(report.warnings.some((w) => w.includes("agentDir 不存在")), report.warnings.join("\n"));
  assert.ok(report.warnings.some((w) => w.includes("没有 models.json")), report.warnings.join("\n"));
});

test("环境里的 SYSTEM.md 会被标出来（它会整体替换系统提示词）", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-env-sys-"));
  writeFileSync(join(root, "SYSTEM.md"), "我是整体替换的提示词\n", "utf-8");

  const report = await (await createLab({ agentDir: root, cwd: root, modelNetwork: false })).inspectEnv();
  assert.ok(report.systemPromptFile?.endsWith("SYSTEM.md"));
  assert.ok(report.warnings.some((w) => w.includes("SYSTEM.md")), report.warnings.join("\n"));
});

test("跑一轮真 agent 时技能真的进了 system —— 报出来的不是纸上名单", async () => {
  const { captureSystemPrompt } = await import("./helpers.ts");
  makeSkill(fauxAgentDir, "env-real-skill");
  const { system } = await captureSystemPrompt({ skills: ["env-real-skill"] });
  assert.match(system, /env-real-skill/);
});
