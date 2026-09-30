// 探针 04：工具接线 —— 白名单要不要带 customTools 名字、审批门能不能真拦住。
// ground truth 取假服务记录的 tools 列表（模型实际看到了什么）。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { check, finish, note, section, startFaux, withTimeout } from "./_support.ts";
import { FAUX_MODEL_ID, makeRuntime } from "./_sdk.ts";

const faux = await startFaux();
const root = mkdtempSync(join(tmpdir(), "aiteam-p04-"));
const agentDir = join(root, "agent");
const runtime = await makeRuntime(agentDir, faux.baseUrl);
const model = runtime.getModel("faux", FAUX_MODEL_ID)!;

const executeCalls: any[] = [];
const myTool = defineTool({
  name: "my_tool",
  label: "My Tool",
  description: "测试用工具",
  parameters: Type.Object({ v: Type.Optional(Type.String()) }),
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    executeCalls.push({
      toolCallId,
      params,
      hasSignal: Boolean(signal),
      hasOnUpdate: Boolean(onUpdate),
      ctxKeys: Object.keys(ctx ?? {}).slice(0, 12),
    });
    return { content: [{ type: "text", text: `toolran:${JSON.stringify(params)}` }], details: {} };
  },
});

const blockedTools: string[] = [];
const blocker: InlineExtension = {
  name: "probe-blocker",
  factory: (pi) => {
    pi.on("tool_call", (event) => {
      blockedTools.push(event.toolName);
      return { block: true, reason: "被探针拦下了" };
    });
  },
};

async function makeSession(options: {
  customTools?: any[];
  tools?: string[];
  blockTools?: boolean;
  extensions?: InlineExtension[];
}) {
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: SettingsManager.inMemory({}),
    extensionFactories: options.extensions ?? [],
  });
  await loader.reload();
  return createAgentSession({
    cwd: root,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    customTools: options.customTools,
    tools: options.tools,
    sessionManager: SessionManager.inMemory(root),
    settingsManager: SettingsManager.inMemory({}),
  });
}

section("case A：只给 customTools，不给 tools 白名单");
{
  const { session } = await makeSession({ customTools: [myTool] });
  const before = faux.calls.length;
  await withTimeout(session.prompt("[[tool:my_tool]] 叫我用工具"), 20000, "A");
  const tools = faux.calls[before]?.tools ?? [];
  note("模型看到的工具", tools);
  check("customTools 不写进白名单也能生效", tools.includes("my_tool"), tools.join(","));
}

section("case B：给了 tools 白名单但不含 my_tool");
{
  const { session } = await makeSession({ customTools: [myTool], tools: ["read"] });
  const before = faux.calls.length;
  await withTimeout(session.prompt("[[tool:my_tool]] 再来一次"), 20000, "B");
  const tools = faux.calls[before]?.tools ?? [];
  note("模型看到的工具", tools);
  check("白名单里没有 my_tool 时它不生效（决策 #4 的依据）", !tools.includes("my_tool"), tools.join(","));
  check("白名单里的 read 在", tools.includes("read"), tools.join(","));
}

section("case C：白名单同时含 read 与 my_tool");
{
  const { session } = await makeSession({ customTools: [myTool], tools: ["read", "my_tool"] });
  const before = faux.calls.length;
  await withTimeout(session.prompt("[[tool:my_tool]] 第三次"), 20000, "C");
  const tools = faux.calls[before]?.tools ?? [];
  note("模型看到的工具", tools);
  check("显式列进白名单后生效", tools.includes("my_tool"), tools.join(","));
  check("工具真的被执行了", executeCalls.length > 0, `executeCalls=${executeCalls.length}`);
  note("execute 收到的参数", executeCalls[0]);
}

section("case D：tool_call 扩展能不能真拦住工具");
{
  const before = executeCalls.length;
  const { session } = await makeSession({
    customTools: [myTool],
    tools: ["read", "my_tool"],
    extensions: [blocker],
  });
  await withTimeout(session.prompt("[[tool:my_tool]] 这次会被拦"), 20000, "D");
  check("tool_call 处理器被触发", blockedTools.includes("my_tool"), blockedTools.join(","));
  check("被拦的工具没有执行", executeCalls.length === before, `execute 次数 ${before} → ${executeCalls.length}`);
}

await faux.close();
finish();
