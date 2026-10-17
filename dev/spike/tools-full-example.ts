// 验证文档 §8 那个完整示例（目前只是构思）——真跑一遍
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here0 = dirname(fileURLToPath(import.meta.url));
import { makeOfflineAgent } from "../examples/lib/harness.ts";

const readIt = async (p: string) => readFileSync(join(here0, p), "utf8");

const readSecretFile = defineTool({
  name: "read_secret_file", label: "Read Secret",
  description: "读一个文件（内部步骤）",
  exposure: "hidden",
  parameters: Type.Object({ path: Type.String() }),
  execute: async (_id, p) => ({ content: [{ type: "text" as const, text: await readIt(p.path) }], details: {} }),
});

const readRedacted = defineTool({
  name: "read_redacted", label: "Read Redacted",
  description: "读文件并自动脱敏敏感信息。路径用相对路径。",
  promptSnippet: "read_redacted: 读文件（自动脱敏）",
  promptGuidelines: ["读配置文件时优先用它，而不是 read。"],
  parameters: Type.Object({ path: Type.String({ description: "相对路径" }) }),
  prepareArguments: (args) => {
    const a = args as Record<string, unknown>;
    return { path: String(a.path ?? a.file ?? "").replace(/^\.\//, "") };
  },
  executionMode: "sequential",
  annotations: { readOnlyHint: true, idempotentHint: true },
  execute: async (_id, p, _sig, _upd, ctx) => {
    console.log("    [read_redacted] p =", JSON.stringify(p), "| ctx 有 executeTool?", typeof ctx?.executeTool);
    const out: any = await ctx.executeTool("read_secret_file", { path: p.path });
    console.log("    [read_redacted] executeTool 返回:", JSON.stringify(out).slice(0, 220));
    if (out.isError) {
      return { content: [{ type: "text" as const, text: `读不到 ${p.path}` }], details: { isError: true } };
    }
    const raw = String(out.result?.content?.[0]?.text ?? "");
    const safe = raw.replace(/(sk-|oc_sk_)[A-Za-z0-9_-]+/g, "$1<已脱敏>");
    return { content: [{ type: "text" as const, text: safe }], details: { bytes: safe.length } };
  },
});

const a = await makeOfflineAgent({ tools: { custom: [readSecretFile, readRedacted] } });

// 第二道防线
a.tools.onResult((result: any) => {
  if (result.toolName !== "read_secret_file") return undefined;
  return {
    content: result.content.map((c: any) =>
      c.type === "text" ? { ...c, text: c.text.replace(/(sk-|oc_sk_)[A-Za-z0-9_-]+/g, "$1<已脱敏>") } : c),
  };
});

console.log("活跃集:", a.io.raw.getActiveToolNames().join(", "));
console.log("system 含 promptSnippet:", a.io.raw.systemPrompt.includes("read_redacted: 读文件"));

// 造一个带密钥的文件
const { writeFileSync } = await import("node:fs");
writeFileSync(join(here0, "app.json"), '{"key":"oc_sk_REALSECRET123456","port":8080}\n');

// ① 外层工具（应脱敏）
let r = await a.io.prompt(`[[tool:read_redacted]] [[args:{"file":"app.json"}]] 读它`);
console.log("\n① 经 read_redacted（用旧参数名 file）:");
console.log("   ", r.text.slice(0, 200));
console.log("   含真密钥？", r.text.includes("REALSECRET") ? "✗ 漏了" : "✓ 已脱敏");

// ② 直接调内层（第二道防线应拦住）
r = await a.io.prompt(`[[tool:read_secret_file]] [[args:{"path":"app.json"}]] 读它`);
console.log("\n② 直接调 read_secret_file:");
console.log("   ", r.text.slice(0, 200));
console.log("   含真密钥？", r.text.includes("REALSECRET") ? "✗ 漏了" : "✓ 已脱敏（第二道防线生效）");
a.dispose();
