// 决策 #8/#9：ModelRuntime 按 agentDir 缓存 —— 一个凭证集一个 runtime。
// 回归：曾经是模块级全局单例（`sharedRuntime ??=`），于是第二个不同 agentDir 的分身
// 仍去读**第一个** agentDir 的 models.json/auth.json —— 表现为「模型找不到」，
// 报错信息还会把原因指向模型名，完全看不出去错了盘。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/index.ts";
import { writeModelsJson } from "./faux-models.ts";
import { faux } from "./helpers.ts";

/** 一个只属于本次测试的 agentDir，它的 models.json 里只有一个本目录专属的模型名 */
function isolatedDir(modelId: string) {
  const root = mkdtempSync(join(tmpdir(), "aiteam-dir-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  writeModelsJson(agentDir, faux.baseUrl, modelId);
  return { agentDir, cwd, modelRef: `faux/${modelId}` };
}

test("不同 agentDir 的分身各读各自的 models.json", async () => {
  const a = isolatedDir("模型A");
  const b = isolatedDir("模型B");

  // 不传 modelRuntime —— 走库自己的 getSharedRuntime，这才是被测的那条路径
  const agentA = await createAgent({ model: a.modelRef, cwd: a.cwd, agentDir: a.agentDir });
  try {
    assert.equal(agentA.status, "idle");

    const agentB = await createAgent({ model: b.modelRef, cwd: b.cwd, agentDir: b.agentDir });
    try {
      const run = await agentB.prompt("hi");
      assert.match(run.text, /echo:hi/, "B 应当用自己 agentDir 里的模型跑起来");
      assert.equal(run.error, undefined);
    } finally {
      agentB.dispose();
    }
  } finally {
    agentA.dispose();
  }
});
