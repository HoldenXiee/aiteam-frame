// SDK 侧公用件：把假 provider 写进 models.json，并造出 ModelRuntime。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const FAUX_PROVIDER = "faux";
export const FAUX_MODEL_ID = "echo";
export const FAUX_MODEL_REF = `${FAUX_PROVIDER}/${FAUX_MODEL_ID}`;

export function writeModelsJson(agentDir: string, baseUrl: string): string {
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
            models: [
              {
                id: FAUX_MODEL_ID,
                name: "Faux Echo",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );
  return modelsPath;
}

export async function makeRuntime(agentDir: string, baseUrl: string): Promise<ModelRuntime> {
  const modelsPath = writeModelsJson(agentDir, baseUrl);
  return ModelRuntime.create({ modelsPath, allowModelNetwork: false });
}

/** 取会话里所有 assistant 文本，判断「模型回了什么」的 ground truth 之一 */
export function assistantTexts(session: any): string[] {
  return session.messages
    .filter((m: any) => m.role === "assistant")
    .map((m: any) =>
      (m.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join(""),
    );
}

export function lastAssistant(session: any): any {
  const list = session.messages.filter((m: any) => m.role === "assistant");
  return list[list.length - 1];
}
