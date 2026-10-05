// 探针：promptSnippet / promptGuidelines 到底进不进 system prompt？
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLab } from "../src/index.ts";

process.env.PI_OFFLINE = "1";
const root = mkdtempSync(join(tmpdir(), "tools-"));
const agentDir = join(root, "agent"), cwd = join(root, "work");
mkdirSync(agentDir, { recursive: true }); mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { faux: { name: "F", baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "k", models: [{ id: "echo", name: "e", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }] } } }));
writeFileSync(join(agentDir, "auth.json"), "{}");

const bare = defineTool({
  name: "bare_tool", label: "Bare", description: "没有 promptSnippet 的工具",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
});
const rich = defineTool({
  name: "rich_tool", label: "Rich", description: "有 promptSnippet 的工具",
  promptSnippet: "rich_tool: SNIPPET_MARKER_XYZ",
  promptGuidelines: ["GUIDELINE_MARKER_ABC 用 rich_tool 之前先想清楚"],
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
});

const lab = await createLab({ agentDir, cwd, modelNetwork: false });
const a = await lab.createAgent({ model: "faux/echo", tools: { custom: [bare, rich] } });
const sys = a.io.raw.systemPrompt;
console.log("含 SNIPPET_MARKER_XYZ :", sys.includes("SNIPPET_MARKER_XYZ"));
console.log("含 GUIDELINE_MARKER_ABC:", sys.includes("GUIDELINE_MARKER_ABC"));
console.log("含 bare_tool 字面名 :", sys.includes("bare_tool"));
const i = sys.indexOf("<tools>");
console.log("---- <tools> 段 ----");
console.log(sys.slice(i, sys.indexOf("</tools>") + 8));
a.dispose();
