// 实验室（Lab）：环境所有者与唯一启动入口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createLab } from "../src/agent/lab.ts";
import { getSharedRuntime } from "../src/agent/create-agent.ts";
import { fauxAgentDir, fauxCwd, FAUX_MODEL_REF } from "./helpers.ts";

test("实验室必填两个目录：缺失与空串都拒绝", async () => {
  await assert.rejects(() => createLab({ cwd: fauxCwd } as never), /agentDir/);
  await assert.rejects(() => createLab({ agentDir: fauxAgentDir } as never), /cwd/);
  await assert.rejects(() => createLab({ agentDir: "", cwd: fauxCwd }), /agentDir/);
  await assert.rejects(() => createLab({ agentDir: fauxAgentDir, cwd: "" }), /cwd/);
});

test("cwd 不存在时当场报错", async () => {
  await assert.rejects(
    () => createLab({ agentDir: fauxAgentDir, cwd: join(fauxCwd, "no-such-dir"), modelNetwork: false }),
    /不存在|cwd/,
  );
});

test("lab.createAgent 不传 spec 也能起，且真的能跑一轮", async () => {
  const lab = await createLab({ agentDir: fauxAgentDir, cwd: fauxCwd, modelNetwork: false });
  const a = await lab.createAgent();
  const r = await a.io.prompt("说一句话");
  assert.ok(r.text.length > 0);
  a.dispose();
});

test("同一个 agentDir 的两个实验室共用同一份 modelRuntime", async () => {
  const opts = { modelNetwork: false } as const;
  const lab = await createLab({ agentDir: fauxAgentDir, cwd: fauxCwd, ...opts });
  assert.equal(
    await lab.modelRuntimeForTest(),
    await getSharedRuntime(fauxAgentDir, opts),
    "实验室必须复用宿主级共享 runtime，不能自己另建一份",
  );
});

test("lab.inspectEnv 只读报告这个实验室的环境", async () => {
  const lab = await createLab({ agentDir: fauxAgentDir, cwd: fauxCwd, modelNetwork: false });
  const report = await lab.inspectEnv();
  assert.equal(report.agentDir, fauxAgentDir);
  assert.equal(report.cwd, fauxCwd);
});
