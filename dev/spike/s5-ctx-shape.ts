// S5：AgentContext 能不能用 { ...ctx } 展开？
// 规格 §4.1 打算把 pi 的 ExtensionContext 原样透传再挂 agent / runId。
// 若 ctx 的方法在原型上，展开就会丢方法（静默失效）。
import { check, head, rig } from "./_pi.ts";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

head("S5 ctx 形状（展开是否安全）");

const facts: Record<string, unknown> = {};
const probe: InlineExtension = (pi) => {
  pi.on("tool_call", (_event, ctx: any) => {
    const proto = Object.getPrototypeOf(ctx);
    facts.constructor = proto?.constructor?.name ?? null;
    facts.ownKeys = Object.keys(ctx).sort();
    facts.ownAbort = Object.prototype.hasOwnProperty.call(ctx, "abort");
    facts.ownGetContextUsage = Object.prototype.hasOwnProperty.call(ctx, "getContextUsage");
    facts.abortType = typeof ctx.abort;
    facts.spreadAbortType = typeof { ...ctx }.abort;
    facts.spreadGetContextUsageType = typeof { ...ctx }.getContextUsage;
    facts.spreadHasAgentWouldWork = typeof { ...ctx }.agent === "undefined";
    // 展开只保住「函数存在」；能不能调还得真调一次（看函数里是否用 this）
    const spread: any = { ...ctx };
    try {
      facts.spreadIsIdleResult = spread.isIdle();
    } catch (err) {
      facts.spreadIsIdleError = String(err);
    }
    try {
      facts.spreadSystemPromptLen = spread.getSystemPrompt()?.length ?? 0;
    } catch (err) {
      facts.spreadSystemPromptError = String(err);
    }
    try {
      facts.spreadUsage = spread.getContextUsage() === undefined ? "undefined" : "有值";
    } catch (err) {
      facts.spreadUsageError = String(err);
    }
    try {
      facts.spreadPending = spread.hasPendingMessages();
    } catch (err) {
      facts.spreadPendingError = String(err);
    }
    // 若要用 Proxy，这条是判据：Reflect.get 传 receiver 才能保住 this
    const proxy = new Proxy(ctx, { get: (t, k, r) => Reflect.get(t, k, r) });
    facts.proxyAbortType = typeof proxy.abort;
    try {
      facts.proxyAbortCallable = typeof proxy.abort === "function";
    } catch (err) {
      facts.proxyAbortError = String(err);
    }
    return undefined;
  });
};

const echo: InlineExtension = (pi) => {
  pi.registerTool(
    defineTool({
      name: "probe_echo",
      label: "Probe Echo",
      description: "回显",
      parameters: Type.Object({ text: Type.Optional(Type.String()) }),
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
    }),
  );
};

const r = await rig([probe, echo]);
try {
  await r.session.prompt("[[tool:probe_echo]]");
} catch (err) {
  console.log("  prompt 报错（不影响结论）：", String(err).slice(0, 120));
}

console.log("  观察到：", JSON.stringify(facts, null, 2));
check("ctx 方法是自有属性（函数本体不丢）", facts.ownAbort === true, `ownAbort=${facts.ownAbort}`);
check("展开后函数仍存在", facts.spreadAbortType === "function", `spread.abort=${facts.spreadAbortType}`);
check("展开后**真能调用**（方法不依赖 this）", facts.spreadIsIdleError === undefined, facts.spreadIsIdleError);
check("Proxy + Reflect.get(receiver) 也能用", facts.proxyAbortType === "function", `proxy.abort=${facts.proxyAbortType}`);

await r.close();