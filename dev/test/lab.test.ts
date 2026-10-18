// 实验室（Lab）：环境所有者与唯一启动入口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { createLab } from "../../src/agent/lab.ts";
import { getSharedRuntime } from "../../src/agent/create-agent.ts";
import { fauxAgentDir, fauxCwd, FAUX_MODEL_REF, FAUX_MODEL_ALT_REF, FAUX_MODEL_ALT_ID } from "./helpers.ts";

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

// ══════════════════════════════════════════════════════════════════
// ★★★ 模型白名单（`createLab({ modelAllow })`）—— 2026-10-18 实测事故的回归
//
// 事故：一个只声明了 `opencode-go/deepseek-v4.1-flash` 的实验室，**静默地**用了别的型号。
// 两个漏口：
//   ① `sandbox.spawn({ model })` 的 `model` 是**模型运行时自己填的参数** —— 绕过所有钉死点
//   ② **不传** `model` 时旧行为是「不解析」⇒ 落到 **pi 的全局默认**（使用者控制不到）
// ★ 这是「一个能力多个入口」（P17）在**型号**上的再现：堵了 5 个入口，第 6 个是模型开的。
// ══════════════════════════════════════════════════════════════════

test("modelAllow：不在名单里的型号在创建期就被拦下", async () => {
  const labAllow = await createLab({
    agentDir: fauxAgentDir, cwd: fauxCwd, modelNetwork: false,
    modelAllow: [FAUX_MODEL_REF],
  });
  // 名单内：正常
  const ok = await labAllow.createAgent({ model: FAUX_MODEL_REF });
  ok.dispose();
  // 名单外（等价于 sandbox.spawn({ model: "…" }) 那条路）：必须抛错，不许静默放行
  await assert.rejects(
    () => labAllow.createAgent({ model: FAUX_MODEL_ALT_REF }),
    /不在这个实验室允许的型号里/,
  );
});

test("modelAllow：不传 model 时用实验室默认，而不是 pi 的全局默认", async () => {
  const labAllow = await createLab({
    agentDir: fauxAgentDir, cwd: fauxCwd, modelNetwork: false,
    modelAllow: [FAUX_MODEL_REF], defaultModel: FAUX_MODEL_REF,
  });
  const a = await labAllow.createAgent({});    // ★ 故意不传 model
  try {
    assert.equal(a.model.current?.id, FAUX_MODEL_REF.split("/")[1], "必须落到实验室声明的默认型号");
  } finally { a.dispose(); }
});

test("modelAllow：运行期 model.set 也要过名单（不能绕开创建期的限制）", async () => {
  const labAllow = await createLab({
    agentDir: fauxAgentDir, cwd: fauxCwd, modelNetwork: false,
    modelAllow: [FAUX_MODEL_REF], defaultModel: FAUX_MODEL_REF,
  });
  const a = await labAllow.createAgent({});
  try {
    await assert.rejects(() => a.model.set(FAUX_MODEL_ALT_REF), /不在这个实验室允许的型号里/);
  } finally { a.dispose(); }
});

test("modelAllow：不传它时保持旧行为（不限制）", async () => {
  const free = await createLab({ agentDir: fauxAgentDir, cwd: fauxCwd, modelNetwork: false });
  const a = await free.createAgent({ model: FAUX_MODEL_ALT_REF });
  try {
    assert.equal(a.model.current?.id, FAUX_MODEL_ALT_ID, "没声明白名单 ⇒ 不限制（向后兼容）");
  } finally { a.dispose(); }
});

test("modelAllow：defaultModel 不在名单里 → 构造时就报错（不是等起 agent 才炸）", async () => {
  await assert.rejects(
    () => createLab({
      agentDir: fauxAgentDir, cwd: fauxCwd, modelNetwork: false,
      modelAllow: [FAUX_MODEL_REF], defaultModel: FAUX_MODEL_ALT_REF,
    }),
    /不在 modelAllow 里/,
  );
});
