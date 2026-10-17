// 实验室（Lab）：环境所有者与唯一启动入口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { createLab } from "../src/agent/lab.ts";
import { getSharedRuntime } from "../src/agent/create-agent.ts";
import { fauxAgentDir, fauxCwd, FAUX_MODEL_REF } from "./helpers.ts";

test("实验室必填两个目录：缺失与空串都拒绝", async () => {
  // 不传参数（JS 调用者 / 漏传整个对象）也必须给本库的文案，不能是原生 TypeError：
  // 这里断言整句「createLab：agentDir 必填」而不是 /agentDir/ —— 后者能被
  // TypeError: Cannot read properties of undefined (reading 'agentDir') 蒙混过关。
  await assert.rejects(() => createLab(undefined as never), /createLab：agentDir 必填/);
  await assert.rejects(() => createLab({ cwd: fauxCwd } as never), /agentDir/);
  await assert.rejects(() => createLab({ agentDir: fauxAgentDir } as never), /cwd/);
  await assert.rejects(() => createLab({ agentDir: "", cwd: fauxCwd }), /agentDir/);
  await assert.rejects(() => createLab({ agentDir: fauxAgentDir, cwd: "" }), /cwd/);
});

test("cwd 不存在时当场报错", async () => {
  await assert.rejects(
    () => createLab({ agentDir: fauxAgentDir, cwd: join(fauxCwd, "no-such-dir"), modelNetwork: false }),
    /cwd 不存在/,
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
    // 它抓的是「createAgentInLab 自己 ModelRuntime.create 另建一份」那类走样；
    // 「自己去调一次 getSharedRuntime(同一 agentDir、同一开关)」它抓不住 —— 缓存会把同一个对象
    // 还给它，断言照样绿（注入那一类由下一个用例钉）。
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
    // 缓存键必须规范化：同一目录的两种写法（例如尾随一个 `.`）也得命中同一份 ——
    // 否则一个凭证集会拿到两份 runtime，读改写同一个 auth.json 时互相覆盖。
    assert.equal(
      await getSharedRuntime(`${fauxAgentDir}${sep}.`, opts),
      await getSharedRuntime(fauxAgentDir, opts),
      "同一 agentDir 的不同写法必须命中同一份 runtime",
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
