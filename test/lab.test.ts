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
  const a = await createLab({ agentDir: fauxAgentDir, cwd: fauxCwd, ...opts });
  const b = await createLab({ agentDir: fauxAgentDir, cwd: fauxCwd, ...opts });
  const agentA = await a.createAgent({ model: FAUX_MODEL_REF });
  const agentB = await b.createAgent({ model: FAUX_MODEL_REF });
  try {
    // 断言落在**真的跑起来的那份**（agent 手里的 runtime）上，不是实验室的探针：
    // 若 createAgentInLab 自己去取一次 runtime，「两个实验室共用」这条就开始骗人了。
    assert.equal(
      agentA.model.raw.modelRuntime,
      agentB.model.raw.modelRuntime,
      "同一个 agentDir 的两个实验室必须共用同一份 runtime，不能各自另建",
    );
    assert.equal(
      agentA.model.raw.modelRuntime,
      await getSharedRuntime(fauxAgentDir, opts),
      "还必须正是宿主级共享的那份",
    );
  } finally {
    agentA.dispose();
    agentB.dispose();
  }
});

test("LabOptions.modelRuntime 注入的那份真的到达 agent", async () => {
  // 故意换一个网络开关取值：cache key 不同 ⇒ 这是与实验室默认那份**不同**的 runtime 对象，
  // 于是「注入了但被忽略」会立刻被下面这行抓住。
  const injected = await getSharedRuntime(fauxAgentDir, { modelNetwork: true });
  const lab = await createLab({ agentDir: fauxAgentDir, cwd: fauxCwd, modelNetwork: false, modelRuntime: injected });
  const a = await lab.createAgent({ model: FAUX_MODEL_REF });
  try {
    assert.equal(a.model.raw.modelRuntime, injected, "注入的 runtime 必须真的被 agent 用上，不能被静默忽略");
  } finally {
    a.dispose();
  }
});

test("lab.inspectEnv 只读报告这个实验室的环境", async () => {
  const lab = await createLab({ agentDir: fauxAgentDir, cwd: fauxCwd, modelNetwork: false });
  const report = await lab.inspectEnv();
  assert.equal(report.agentDir, fauxAgentDir);
  assert.equal(report.cwd, fauxCwd);
});
