// 把假 provider 写进 models.json。
//
// 与 test/faux-models.ts 同源，但照抄而非 import，并删掉示例用不到的部分
// （`makeFauxRuntime` / `assistantTexts` / `lastAssistant`）：harness 走的是库的真实入口
// `createAgent`，runtime 由它自己去读 `models.json`，示例不需要自己造 ModelRuntime。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FAUX_PROVIDER = "faux";
export const FAUX_MODEL_ID = "echo";
export const FAUX_MODEL_REF = `${FAUX_PROVIDER}/${FAUX_MODEL_ID}`;
/** 第二个模型：`model.set` 这类「换一个模型」的示例要有个换过去的对象 */
export const FAUX_MODEL_ALT_ID = "echo-alt";
export const FAUX_MODEL_ALT_REF = `${FAUX_PROVIDER}/${FAUX_MODEL_ALT_ID}`;
/** 支持思考档（reasoning）的那个模型：不支持的话可用档只有 ["off"]，`setThinking` 的合法值就演示不出来 */
const REASONING_MODEL_IDS = new Set([FAUX_MODEL_ALT_ID]);

export function writeModelsJson(
  agentDir: string,
  baseUrl: string,
  modelIds: string | string[] = FAUX_MODEL_ID,
): string {
  const ids = Array.isArray(modelIds) ? modelIds : [modelIds];
  mkdirSync(agentDir, { recursive: true });
  const modelsPath = join(agentDir, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify(
      {
        providers: {
          [FAUX_PROVIDER]: {
            name: "Faux",
            baseUrl,
            api: "openai-completions",
            apiKey: "faux-key",
            models: ids.map((id) => ({
              id,
              name: `Faux ${id}`,
              reasoning: REASONING_MODEL_IDS.has(id),
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 8192,
            })),
          },
        },
      },
      null,
      2,
    ),
  );
  return modelsPath;
}
