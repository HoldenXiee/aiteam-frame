// 沙箱面：给模型写代码编排 agent 的手段。
//
// 判别力（每条在实现之前必须**红**）：
//   1. 能力白名单真的挡得住 —— 没声明的能力**连存在都看不见**（不在 description、不在 ALL_TOOLS）
//   2. 脚本里的并发是真的并行
//   3. 脚本里 spawn 的子 agent **没有沙箱**（限一层）
//   4. 一个脚本只回一条工具结果（省上下文，这是沙箱的主要价值）
//   5. 沙箱是隔离的（脚本摸不到 process / require）
import { strict as assert } from "node:assert";
import test from "node:test";
import { createSandbox } from "../../src/surfaces/sandbox.ts";
import { lab, makeOfflineAgent, sentTools } from "../examples/lib/harness.ts";

test("能力白名单：没声明的能力连存在都看不见", async () => {
  const agent = await makeOfflineAgent();
  try {
    const sb = createSandbox({
      lab,
      agent,
      capabilities: ["prompt"], // 只给 prompt
    });
    try {
      assert.deepEqual(sb.capabilities, ["prompt"]);
      // description 是模型唯一能看到的东西 —— 没声明的能力不许出现在里面
      const desc = JSON.stringify(sb.tool);
      assert.ok(desc.includes("tools.prompt"), "声明了的要在描述里");
      assert.ok(!desc.includes("tools.spawn"), "没声明的 spawn 不许出现");
      assert.ok(!desc.includes("tools.dispose"), "没声明的 dispose 不许出现");
    } finally {
      sb.close();
    }
  } finally {
    agent.dispose();
  }
});

test("全给：capabilities 展开成 12 项", async () => {
  const agent = await makeOfflineAgent();
  try {
    const sb = createSandbox({ lab, agent, capabilities: ["*"] });
    try {
      assert.equal(sb.capabilities.length, 12);
      assert.ok(sb.capabilities.includes("spawn"));
    } finally {
      sb.close();
    }
  } finally {
    agent.dispose();
  }
});

test("沙箱工具能加进 agent，且模型下一轮真的收到它", async () => {
  const agent = await makeOfflineAgent();
  try {
    const sb = createSandbox({ lab, agent, capabilities: ["prompt"] });
    await agent.io.waitIdle();
    await agent.tools.add(sb.tool);
    assert.ok(agent.tools.list().some((t) => t.name === "codemode" && t.active));
    // 加完之后才请求：看模型实际收到的工具声明
    await agent.io.prompt("随便说点什么");
    assert.ok(sentTools().includes("codemode"), `模型收到的工具里有 codemode：${sentTools().join(",")}`);
    sb.close();
  } finally {
    agent.dispose();
  }
});

test("沙箱执行：并发真的并行（同一脚本里 5 个调用并行）", async () => {
  const mod = await import("@earendil-works/pi-codemode");
  const { InlineCodemodeSandbox, loadQuickJSWasm } = mod;
  // 一个每次耗时 80ms 的工具：串行要 400ms+，并发应该接近 80ms
  const slow: import("@earendil-works/pi-codemode").CodemodeTool = {
    name: "slow",
    execute: async () => {
      await new Promise((r) => setTimeout(r, 80));
      return "done";
    },
  };
  const sb = new InlineCodemodeSandbox({ tools: [slow], wasm: await loadQuickJSWasm() });
  try {
    const t0 = Date.now();
    const r = await sb.execute(
      `return (await Promise.all([1,2,3,4,5].map(() => tools.slow({})))).length;`,
    );
    const ms = Date.now() - t0;
    assert.ok(r.ok, `该成功：${JSON.stringify(r.ok ? null : r.error)}`);
    assert.equal(r.value, 5);
    assert.ok(ms < 250, `5 个 80ms 的调用应并发完成，实测 ${ms}ms（串行会是 400ms+）`);
  } finally {
    sb.close();
  }
});

test("隔离性：脚本摸不到 process / require / fetch", async () => {
  const { InlineCodemodeSandbox, loadQuickJSWasm } = await import("@earendil-works/pi-codemode");
  const sb = new InlineCodemodeSandbox({ tools: [], wasm: await loadQuickJSWasm() });
  try {
    const r = await sb.execute(`
      const has = (n) => { try { return typeof eval(n) !== "undefined"; } catch { return false; } };
      const deep = (() => { try { return typeof this !== "undefined" && typeof this.process !== "undefined"; } catch { return false; } })();
      return { process: has("process"), require: has("require"), fetch: has("fetch"), deepProcess: deep };
    `);
    assert.ok(r.ok, `脚本该成功：${JSON.stringify(r.ok ? null : r.error)}`);
    assert.deepEqual(r.value, { process: false, require: false, fetch: false, deepProcess: false });
  } finally {
    sb.close();
  }
});

test("沙箱工具跑真脚本：调 prompt 能力，且调用轨迹被记下来", async () => {
  const agent = await makeOfflineAgent();
  try {
    const sb = createSandbox({ lab, agent, capabilities: ["prompt", "list_agents"] });
    try {
      const def = sb.tool as unknown as {
        execute(id: string, params: { script: string }): Promise<{ content: { text: string }[]; details: { ok: boolean; calls: unknown[] } }>;
      };
      // 脚本只调 list_agents（不会真花钱），验证管道 + 轨迹
      const out = await def.execute("call-1", {
        script: `const kids = await tools.list_agents({}); return { n: kids.length };`,
      });
      assert.equal(out.details.ok, true);
      assert.ok(out.details.calls.length >= 1, "调用轨迹要记下来");
      assert.ok(out.content[0].text.includes("脚本跑完了"), out.content[0].text);
    } finally {
      sb.close();
    }
  } finally {
    agent.dispose();
  }
});
