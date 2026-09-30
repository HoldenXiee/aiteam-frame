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
