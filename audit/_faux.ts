// audit 专用：起一个孤立的 faux 环境（各自的 server + agentDir + runtime）。
// 自己写 models.json（不借用 test/faux-models.ts），以便控制 reasoning / contextWindow 等模型能力位。
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { startFaux, type Faux, type FauxCall } from "../test/faux-server.ts";
import { isolatedRoot } from "./_harness.ts";

export interface ModelDef {
  id: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface Env {
  faux: Faux;
  root: string;
  agentDir: string;
  cwd: string;
  runtime: ModelRuntime;
  runtimeNoNet: ModelRuntime;
  models: ModelDef[];
  /** 第一个模型的引用 */
  model: string;
  ref: (id: string) => string;
  last: () => FauxCall | undefined;
  calls: () => FauxCall[];
  /** 只看真正的对话请求（带 system 或 tools 的） */
  dialog: () => FauxCall[];
  close: () => Promise<void>;
}

export async function makeEnv(models: ModelDef[] | string = "echo"): Promise<Env> {
  const list: ModelDef[] = typeof models === "string" ? [{ id: models }] : models;
  const faux = await startFaux();
  const { root, agentDir, cwd } = isolatedRoot();
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          faux: {
            name: "Faux",
            baseUrl: faux.baseUrl,
            api: "openai-completions",
            apiKey: "faux-key",
            models: list.map((m) => ({
              id: m.id,
              name: `Faux ${m.id}`,
              reasoning: m.reasoning ?? false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: m.contextWindow ?? 200000,
              maxTokens: m.maxTokens ?? 8192,
            })),
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  const runtime = await ModelRuntime.create({
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  // 让「不传 modelRuntime / 不传 agentDir」的路径也落到这个孤立环境里
  process.env.AITEAM_AGENT_DIR = agentDir;
  return {
    faux,
    root,
    agentDir,
    cwd,
    runtime,
    runtimeNoNet: runtime,
    models: list,
    model: `faux/${list[0].id}`,
    ref: (id: string) => `faux/${id}`,
    last: () => faux.calls[faux.calls.length - 1],
    calls: () => faux.calls,
    dialog: () => faux.calls.filter((c) => c.tools.length > 0 || c.system.length > 0),
    close: () => faux.close(),
  };
}

/** 造一个真技能目录：<root>/skills/<name>/SKILL.md */
export function makeSkill(root: string, name: string, description: string, body = "技能正文"): string {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, "utf-8");
  return dir;
}

/** 造一个真扩展文件 */
export function makeExtension(root: string, fileName: string, toolName: string): string {
  const path = join(root, fileName);
  writeFileSync(
    path,
    `export default function (pi) {
  pi.registerTool({ name: "${toolName}", label: "${toolName}", description: "审计用探针工具",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
}\n`,
    "utf-8",
  );
  return path;
}
