import test from "node:test";
import assert from "node:assert/strict";
import { SettingsManager, type Skill } from "@earendil-works/pi-coding-agent";
import { buildLoader } from "../src/agent/loader.ts";
import { captureSystemPrompt, fauxAgentDir, fauxCwd } from "./helpers.ts";

const deps = () => ({ cwd: fauxCwd, agentDir: fauxAgentDir, settingsManager: SettingsManager.inMemory({}) });

test("role 走 appendSystemPrompt，保留 pi 默认提示词与 <tools> 段", async () => {
  const { system } = await captureSystemPrompt({ role: "我是审查员" });
  assert.match(system, /我是审查员/);
  assert.match(system, /<tools>/);
  assert.ok(system.indexOf("我是审查员") > system.indexOf("<tools>"));
});

test("技能名解析失败必须抛错，错误信息含名字", async () => {
  await assert.rejects(() => buildLoader({ skills: ["没有这个技能"] }, deps()), /没有这个技能/);
});

test("Skill 对象指向不存在的文件时抛错", async () => {
  await assert.rejects(
    () =>
      buildLoader(
        {
          skills: [
            { name: "x", description: "d", filePath: "D:/nope/SKILL.md", baseDir: "D:/nope", source: "custom" } as Skill,
          ],
        },
        deps(),
      ),
    /D:\/nope\/SKILL\.md|D:\\nope\\SKILL\.md/,
  );
});
