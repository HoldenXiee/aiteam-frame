// 七个面的端到端联跑（本计划的收口证据）：一个 agent 从创建到回收，依次走遍
// io / context / tools / permissions / extensions / skills / model，并断言它们协同的**可观测结果**
// （模型实际收到的工具名与消息条数、事件流、状态）—— 不是「方法没抛错」。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  FAUX_MODEL_ALT_ID,
  FAUX_MODEL_ALT_REF,
  echoTool,
  faux,
  makeAgent,
  sentMessages,
  sentTools,
} from "./helpers.ts";

test("七面联跑：加工具 → 装门 → 加扩展 → 加技能 → 改上下文 → 换模型 → 观测 → 回收", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aiteam-e2e-"));
  mkdirSync(join(cwd, "skills", "e2e-skill"), { recursive: true });
  writeFileSync(
    join(cwd, "skills", "e2e-skill", "SKILL.md"),
    "---\nname: e2e-skill\ndescription: 七面联跑用的技能\n---\n\n正文\n",
  );

  const a = await makeAgent({
    cwd,
    permissions: { only: ["read"] },
    tools: { custom: [echoTool()] },   // R42：创建期自定义工具
  });
  const events: string[] = [];
  // 注意：处理器必须显式返回 undefined —— `events.push(...)` 的返回值是长度（真值），桥接会把它
  // 当成变换结果交给 pi（`before_provider_request` 上尤其致命）。
  const off = a.onAny((e) => { events.push(e.type); });
  try {
    // tools：运行期加一个工具，它必须真的 active（不是只登记在表里）
    await a.tools.add(echoTool("probe_added"));
    assert.ok(a.tools.list().some((t) => t.name === "probe_added" && t.active));

    // permissions：装一个不拦的门 + allow 已经有的 read（幂等）
    a.permissions.gate(async () => undefined);
    await a.permissions.allow(["read"]);

    // extensions：运行期加一个扩展，它注册 probe_ext
    await a.extensions.add((pi) => pi.registerTool(echoTool("probe_ext") as ToolDefinition));

    // skills：运行期加一个技能
    await a.skills.add("./skills/e2e-skill");
    assert.ok(a.skills.list().some((s) => s.name === "e2e-skill"));

    // model：换模型（`set` 是 Promise<void>、`current` 是 Model 对象 —— R31/R32）
    await a.model.set(FAUX_MODEL_ALT_REF);
    assert.equal(a.model.current?.id, FAUX_MODEL_ALT_ID);

    // io：第一轮。声明面的四个来源（创建期 only / 创建期 custom / 运行期 add / 运行期扩展）都要在
    const first = await a.io.prompt("hello");
    // 断言里带上 error / usage：并发跑全套时偶发过一次空文本（114 例里 1 次，未能复现）。
    // 只报「'' !== 'echo:hello'」看不出是哪一类失败（超时 / 连接 / 假服务没起来）。
    // pi 对「接受后失败」不 reject、只把原因写进 error —— 不打出来就永远是谜。
    assert.equal(
      first.text,
      "echo:hello",
      `第一轮文本不对。error=${JSON.stringify(first.error)} usage=${JSON.stringify(first.usage)}`,
    );
    assert.deepEqual([...sentTools()].sort(), ["probe_added", "probe_echo", "probe_ext", "read"]);
    // 实测校准（不是照抄「system + 1」的假设）：假服务记的 messageCount 含 system 那条，
    // 第一轮还没有历史，所以正好 system + 这一条 user = 2。
    assert.equal(sentMessages(), 2);

    // context：override 只留最后一条。第一轮已留下 (user, assistant)，所以这条有判别力 ——
    // 不 override 的话负载是 system + (user, assistant, user) = 4。
    a.context.override((m) => m.slice(-1));
    await a.io.prompt("second");
    assert.equal(sentMessages(), 2);
    assert.equal(faux.calls[faux.calls.length - 1]?.lastUser, "second");

    // context：自动压缩开关可读写
    a.context.autoCompact = true;
    assert.equal(a.context.autoCompact, true);

    // 观测：事件流覆盖了至少一次完整运行
    assert.ok(events.includes("agent_start"), `没有 agent_start：${events.join(",")}`);
    assert.ok(events.includes("agent_settled"), `没有 agent_settled：${events.join(",")}`);
  } finally {
    off();
    a.dispose();
  }
  assert.equal(a.status, "disposed");
});
