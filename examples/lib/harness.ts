// 示例的离线环境：本机假 provider + 临时 agentDir / cwd。
//
// 每个示例都 `node examples/NN-*.ts` 直接跑，且必须零 API 成本、无需真 key ——
// 所以这里在 import 时就启动假服务、写好自己的 models.json，并把 `PI_OFFLINE=1` 钉死。
// 做法照 test/helpers.ts（照抄，不 import test/：示例不该依赖测试目录的路径）。
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLab, type Agent, type AgentSpec, type AgentTool } from "../../src/index.ts";
import { FAUX_MODEL_ALT_ID, FAUX_MODEL_ALT_REF, FAUX_MODEL_ID, FAUX_MODEL_REF, writeModelsJson } from "./faux-models.ts";
import { startFaux } from "./faux-server.ts";

export { FAUX_MODEL_ALT_REF, FAUX_MODEL_REF };

// 必须在任何 ModelRuntime 建起来之前设：它全局关掉模型目录等一切网络请求。
// 这是「示例不会偷偷联网」的硬保证，不是优化。
process.env.PI_OFFLINE = "1";

/** 假服务句柄：`faux.calls` 记录着模型每次请求**实际收到**了什么（工具声明、system、消息条数） */
export const faux = await startFaux();

const root = mkdtempSync(join(tmpdir(), "aiteam-example-"));
/** 临时 agentDir：models.json 指着假服务，示例跑完即弃 */
export const fauxAgentDir = join(root, "agent");
/** 临时工作目录：示例要落文件时用这里，别把仓库搞脏 */
export const fauxCwd = join(root, "work");
mkdirSync(fauxCwd, { recursive: true });
writeModelsJson(fauxAgentDir, faux.baseUrl, [FAUX_MODEL_ID, FAUX_MODEL_ALT_ID]);

/**
 * 一个示例一个实验室：环境（agentDir / cwd / 离线）只在这里声明一次，
 * 之后本文件与示例都从它起 agent，不再逐个传这两个目录。
 */
export const lab = await createLab({ agentDir: fauxAgentDir, cwd: fauxCwd, modelNetwork: false });

/**
 * 起一个走实验室入口（lab.createAgent）的 agent，默认对着本机假 provider。
 * 签名与 test/helpers.ts 的 makeAgent 一致：给的 spec 覆盖默认值。
 */
export async function makeOfflineAgent(spec: AgentSpec = {}): Promise<Agent> {
  return lab.createAgent({ model: FAUX_MODEL_REF, ...spec });
}

/** 模型实际收到的工具名（index 省略时取最近一次请求）——「工具真的进了声明」的 ground truth */
export function sentTools(index?: number): string[] {
  return faux.calls[index ?? faux.calls.length - 1]?.tools ?? [];
}

/** 一个只回显的静态工具，名字默认 probe_echo */
export function echoTool(name = "probe_echo"): AgentTool {
  const tool: ToolDefinition = defineTool({
    name,
    label: "Probe Echo",
    description: "回显参数里的 text",
    parameters: Type.Object({ text: Type.Optional(Type.String()) }),
    execute: async (_id, params) => ({
      content: [{ type: "text" as const, text: `echo:${params.text ?? ""}` }],
      details: {},
    }),
  });
  return tool;
}

/** 一个本次调用专用的临时工作目录（已创建） */
export function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "aiteam-example-cwd-"));
}
