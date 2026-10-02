// model 面：current / thinking / available 可读，set 换模型、setThinking 换思考档。
//
// 契约（src/agent/types.ts，逐字）：
//   current: Model<any> | undefined   ← **对象**，不是 `provider/id` 字符串
//   available: readonly Model<any>[]  ← 对象数组
//   两者都要比 `.id` / `.provider`，不要比字符串。
//
// 事实依据（spike/s7-model-while-running.ts 实测，别重新猜）：
//   - 假 provider 收到的负载里 `model` 字段是**模型 id**（`echo`），不是 ref（`faux/echo`）；
//   - 非 reasoning 模型（`echo`）的可用思考档只有 `["off"]`，`echo-alt`（faux-models 里标了 reasoning）
//     才是 `["off","minimal","low","medium","high"]`；
//   - pi 的 `setThinkingLevel` 对非法值**静默钳**（`very-high` → `off`），调用方看不出值被改了
//     → 决策 #28：必须在库里自己判并抛错；
//   - 运行中（在飞轮次里）调 `setModel` / `setThinkingLevel` **不会**打断在飞的那轮（跟 compact 不同），
//     改动从**下一次请求**起生效 —— 所以这两个 setter **不加 idle 守卫**（下面两例钉住这一点）。
import test from "node:test";
import assert from "node:assert/strict";
import { faux, makeAgent } from "./helpers.ts";
import { FAUX_MODEL_ALT_ID, FAUX_MODEL_ALT_REF, FAUX_MODEL_ID, FAUX_MODEL_REF, FAUX_PROVIDER } from "./faux-models.ts";
import { sleep } from "./faux-server.ts";

test("current / thinking / available 是活数据（对象，不是字符串 ref）", async () => {
  const a = await makeAgent();
  try {
    assert.equal(a.model.current?.id, FAUX_MODEL_ID);
    assert.equal(a.model.current?.provider, FAUX_PROVIDER);
    // 不写死「恰好两台」：`available` 是**带凭证过滤**的快照，而这台机器上碰巧存在别的 provider 凭证时
    // 会多出别的模型。但「两台假模型都在」+「元素是 Model 对象」这两条与环境无关，也足够钉住契约。
    const ids = a.model.available.map((m) => m.id);
    assert.ok(
      ids.includes(FAUX_MODEL_ID) && ids.includes(FAUX_MODEL_ALT_ID),
      `available 应当含两台假模型，实际：${JSON.stringify(ids)}`,
    );
    assert.ok(
      a.model.available.every((m) => typeof m?.provider === "string" && typeof m?.id === "string"),
      "available 的元素是 Model 对象，不是 `provider/id` 字符串",
    );
    assert.equal(a.model.thinking, "off", "echo 不支持思考（reasoning:false）→ 唯一可用档是 off");
    assert.equal(a.model.raw.session, a.io.raw, "raw.session 就是会话本体");
  } finally {
    a.dispose();
  }
});

test("set 换模型：当前值立刻变，且**下一次请求**真的用了新模型", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("before");
    assert.equal(faux.calls.at(-1)!.model, FAUX_MODEL_ID, "换之前：负载里的 model 是 id（不是 ref）");
    await a.model.set(FAUX_MODEL_ALT_REF);
    assert.equal(a.model.current?.id, FAUX_MODEL_ALT_ID, "set 是 async，await 之后 current 就该是新模型");
    await a.io.prompt("after");
    assert.equal(faux.calls.at(-1)!.model, FAUX_MODEL_ALT_ID, "模型实际收到的 model 字段应当是 echo-alt");
  } finally {
    a.dispose();
  }
});

test("set 写错模型名 → 抛错（带名字），且当前模型不被改坏（决策 #28）", async () => {
  const a = await makeAgent();
  try {
    await assert.rejects(() => a.model.set("nope/nope"), /nope/);
    // 已知 provider + 未知 id：pi 只给 warning，**还会造一个自定义模型出来**（实测：`faux/nope` →
    // `{warning, model:`faux/nope`}`）—— 「有警告也抛」这条分支专门管它，否则服务端只会收到一个不存在的模型
    await assert.rejects(() => a.model.set("faux/nope"), /警告/);
    assert.equal(a.model.current?.id, FAUX_MODEL_ID, "失败的 set 不许留下半应用状态");
  } finally {
    a.dispose();
  }
});

test("setThinking 非法值 → 抛错（带值），且思考档不被静默钳掉（v1 是静默回落）", async () => {
  const a = await makeAgent();
  try {
    await a.model.set(FAUX_MODEL_ALT_REF); // 先站到有思考档的模型上，否则「非法」这个前提不成立
    assert.throws(() => a.model.setThinking("very-high" as never), /very-high/);
    assert.notEqual(a.model.thinking, "very-high");
    assert.equal(a.model.thinking, "off", "抛错之后思考档保持原样（pi 自己会静默钳成别的值）");
  } finally {
    a.dispose();
  }
});

test("setThinking 合法值生效（可用档随当前模型变化）", async () => {
  const a = await makeAgent();
  try {
    // 同一个值在 echo 上非法（它只有 off）、在 echo-alt 上合法 —— 校验看的是**当前模型**的能力
    assert.throws(() => a.model.setThinking("high"), /high/);
    await a.model.set(FAUX_MODEL_ALT_REF);
    a.model.setThinking("high");
    assert.equal(a.model.thinking, "high");
    assert.equal(a.model.raw.session.getAvailableThinkingLevels().includes("high"), true);
  } finally {
    a.dispose();
  }
});

test("运行中 set：不打断在飞那轮（无 idle 守卫），切换从下一次请求起生效", async () => {
  const a = await makeAgent();
  try {
    await a.model.set(FAUX_MODEL_ALT_REF);
    const before = faux.calls.length;
    const p = a.io.prompt("[[sleep:300]] [[tool:read]] 慢");
    await sleep(150); // 让第一条请求真的出去（假服务正卡在 300ms 的 sleep 里）
    assert.equal(faux.calls.length - before, 1, "set 之前那条请求应当已经在飞");
    await a.model.set(FAUX_MODEL_REF); // 运行中调用：不抛、不打断
    const result = await p; // 真价值在这：在飞那轮照常跑完
    assert.ok(result.text.length > 0, `在飞那轮应当正常跑完并拿到文本：${JSON.stringify(result)}`);
    assert.equal(result.error, undefined);
    const turn = faux.calls.slice(before);
    assert.equal(turn.length, 2, "这一轮应当发两条请求（工具调用 → 工具结果）");
    assert.equal(turn[0].model, FAUX_MODEL_ALT_ID, "第一条请求用的还是旧模型");
    assert.equal(turn[1].model, FAUX_MODEL_ID, "切换在下一次请求生效：同一轮后半段已经用新模型");
  } finally {
    a.dispose();
  }
});

test("运行中 setThinking：不打断在飞那轮（无 idle 守卫），新档从下一次请求起上网", async () => {
  const a = await makeAgent();
  try {
    await a.model.set(FAUX_MODEL_ALT_REF);
    a.model.setThinking("off");
    const payloads: any[] = [];
    a.on("before_provider_request", (e: any) => {
      payloads.push(e.payload);
    });
    const p = a.io.prompt("[[sleep:300]] [[tool:read]] 慢");
    await sleep(150);
    assert.doesNotThrow(() => a.model.setThinking("high"), "运行中的合法换档不该被拦");
    assert.equal(a.model.thinking, "high");
    const result = await p;
    assert.ok(result.text.length > 0, `在飞那轮应当正常跑完并拿到文本：${JSON.stringify(result)}`);
    assert.equal(result.error, undefined);
    assert.equal(payloads.length, 2, "这一轮应当有两条出网请求");
    assert.equal(payloads[0]?.reasoning_effort, undefined, "第一条请求还是 off 档（负载里没有 reasoning_effort）");
    assert.equal(payloads[1]?.reasoning_effort, "high", "新档从下一次请求起真的上了负载");
  } finally {
    a.dispose();
  }
});

test("dispose 之后 model 面不许再用", async () => {
  const a = await makeAgent();
  a.dispose();
  assert.throws(() => a.model.current);
  assert.throws(() => a.model.available);
  assert.throws(() => a.model.setThinking("off"));
  await assert.rejects(() => a.model.set(FAUX_MODEL_ALT_REF), /disposed/);
});

// R45：`provider/id:thinking` 后缀不只是「设模型的写法」——创建期它就当思考档用
// （create-agent.ts:98 `spec.thinking ?? resolved.thinkingLevel`），运行期 `set` 也必须兑现它。
// 判据是**模型的 reasoning 能力**（spike S7）：echo-alt 是 reasoning:true，可见档是 ["off","high"]，
// 而 echo 是 reasoning:false、只有 ["off"] —— 同一句 `:high` 在两者上一个成一个不成，
// 所以下面两个用例合起来只可能归因于「后缀被读了吗」，不可能归因于「setThinking 本来就坏了」。
test("R45：set 的后缀思考档真的生效（不是只换模型）", async () => {
  const a = await makeAgent();
  try {
    await a.model.set(`${FAUX_MODEL_ALT_REF}:high`);
    assert.equal(a.model.current?.id, FAUX_MODEL_ALT_ID, "模型换过去了");
    assert.equal(a.model.thinking, "high", "后缀里的档位也必须跟上，不能只兑现一半");
  } finally {
    a.dispose();
  }
});

test("R45 反证：后缀档在该模型不可用时，不许只换模型就了事", async () => {
  const a = await makeAgent();
  try {
    // echo 是 reasoning:false，可见档只有 off ⇒ 后缀 high 非法
    await assert.rejects(() => a.model.set(`${FAUX_MODEL_REF}:high`), /high/);
    assert.equal(a.model.current?.id, FAUX_MODEL_ID, "模型本身是能换的（这里换的是自己）");
  } finally {
    a.dispose();
  }
});
