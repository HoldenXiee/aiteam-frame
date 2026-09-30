import test from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../src/index.ts";
import { FAUX_MODEL_REF } from "./faux-models.ts";
import { faux } from "./helpers.ts";
import { sleep } from "./faux-server.ts";

test("空闲时 send 返回 ran 并真的跑了一轮", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF });
  const before = faux.calls.length;
  const r = await agent.send("空闲投递");
  assert.equal(r.delivered, "ran");
  await agent.waitForIdle();
  // 空闲 steer 会静默丢弃消息 —— 这条锁住 send 没走 steer
  assert.ok(faux.calls.length > before, "应当真的发起了请求");
  assert.match(agent.lastResult!.text, /echo:空闲投递/);
});

test("忙时 send 返回 queued 且不抛错", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF });
  const slow = agent.prompt("[[sleep:600]] 慢");
  await sleep(150);
  assert.equal((await agent.send("插队")).delivered, "queued");
  await slow;
  await agent.waitForIdle();
});

test("同步连发两次 send：第二次也要真的跑，不许静默丢弃", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF });
  const before = faux.calls.length;
  // 不 sleep：这会落在「已发起但 SDK 还没置 isStreaming」的窗口里
  const r1 = await agent.send("第一条");
  const r2 = await agent.send("第二条");
  assert.equal(r1.delivered, "ran");
  assert.equal(r2.delivered, "queued", "第二次投递必须被当作忙时排队");

  await agent.waitForIdle();
  const sent = faux.calls.slice(before).map((c) => c.lastUser).join(" | ");
  assert.match(sent, /第一条/, sent);
  assert.match(sent, /第二条/, sent);
  assert.match(agent.lastResult!.text, /echo:第二条/);
});

test("忙时 prompt() 抛错（锁住 SDK 行为）", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF });
  const slow = agent.prompt("[[sleep:600]] 慢");
  await sleep(150);
  await assert.rejects(() => agent.prompt("插队"), /already processing/);
  await slow;
});

test("waitForIdle 在忙时会等待", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF });
  void agent.prompt("[[sleep:400]] 慢");
  await agent.waitForIdle();
  assert.equal(agent.isStreaming, false);
});

test("abort 后 status 为 aborted", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF });
  const slow = agent.prompt("[[sleep:600]] 慢").catch(() => {});
  await sleep(150);
  await agent.abort();
  assert.equal(agent.status, "aborted");
  await slow;
});

test("已 dispose 后 send/waitForIdle 的行为已定义", async () => {
  const dead = await createAgent({ model: FAUX_MODEL_REF });
  dead.dispose();
  await assert.rejects(() => dead.send("x"), /disposed/);
  await dead.waitForIdle(); // 已回收的分身直接 resolve，不抛错（决策 #21）
});
