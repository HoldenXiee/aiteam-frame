// S4：同一个钩子挂多个 handler，谁跑、什么顺序、拦住了以后别人还跑吗？
// 规格 §3.4 的「顺序规则」要么能写死，要么就得承认不保证。
import { check, head, rig } from "./_pi.ts";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

head("S4 多 handler 合并 / 顺序");

const log: string[] = [];
const executed: string[] = [];

const echo: InlineExtension = (pi) => {
  pi.registerTool(
    defineTool({
      name: "probe_echo",
      label: "Probe Echo",
      description: "回显",
      parameters: Type.Object({ text: Type.Optional(Type.String()) }),
      execute: async () => {
        executed.push("probe_echo");
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    }),
  );
};

// 同一个扩展里挂三个 tool_call handler，中间那个拦截
const extA: InlineExtension = (pi) => {
  pi.on("tool_call", () => {
    log.push("A1");
    return undefined;
  });
  pi.on("tool_call", () => {
    log.push("A2");
    return { block: true, reason: "A2 拦截" };
  });
  pi.on("tool_call", () => {
    log.push("A3");
    return undefined;
  });
};

// 另一个扩展也挂一个
const extB: InlineExtension = (pi) => {
  pi.on("tool_call", () => {
    log.push("B1");
    return undefined;
  });
};

const r = await rig([echo, extA, extB]);
try {
  await r.session.prompt("[[tool:probe_echo]]");
  console.log(`  handler 调用顺序：${log.join(" → ") || "(一个都没跑)"}`);
  check("同扩展内多个 handler 都会跑", log.filter((x) => x.startsWith("A")).length >= 1, log.join(","));
  check("A2 返回 block 后，**后面的 A3 还跑吗**", log.includes("A3"), log.includes("A3") ? "跑了（不短路）" : "没跑（短路）");
  check("跨扩展的 B1 跑了吗", log.includes("B1"), log.includes("B1") ? "跑了" : "被 A2 拦住了");
  check("被拦的工具**没有真的执行**", executed.length === 0, `executed=[${executed.join(",")}]`);

  // 只看「拦不住的」情况下的顺序：重新起一个不带 block 的会话
  const log2: string[] = [];
  const extC: InlineExtension = (pi) => {
    pi.on("tool_call", () => {
      log2.push("C1");
      return undefined;
    });
  };
  const extD: InlineExtension = (pi) => {
    pi.on("tool_call", () => {
      log2.push("D1");
      return undefined;
    });
  };
  const r2 = await rig([echo, extC, extD]);
  try {
    await r2.session.prompt("[[tool:probe_echo]]");
    console.log(`  两个扩展（无拦截）的顺序：${log2.join(" → ")}`);
    check("跨扩展顺序 = 注册顺序", log2.join(",") === "C1,D1", log2.join(","));
  } finally {
    await r2.close();
  }
} finally {
  await r.close();
}