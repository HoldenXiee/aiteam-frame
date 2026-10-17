// 探路公共基建：直连 pi SDK + 本机假 provider，零 API 成本。
// 刻意不经过 src/ —— 探路要问的是「pi 的行为」，不是「v1 的行为」。
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  resolveCliModel,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { startFaux, sleep, type Faux, type FauxCall } from "../test/faux-server.ts";
import { FAUX_MODEL_REF, writeModelsJson } from "../test/faux-models.ts";

process.env.PI_OFFLINE = "1";

export { sleep };
export const FAUX_REF = FAUX_MODEL_REF;

export interface Rig {
  faux: Faux;
  cwd: string;
  loader: DefaultResourceLoader;
  session: any;
  /** 假服务收到的全部请求（模型实际收到什么，ground truth） */
  calls: FauxCall[];
  lastCall(): FauxCall | undefined;
  close(): Promise<void>;
}

export async function rig(factories: InlineExtension[] = []): Promise<Rig> {
  const faux = await startFaux();
  const root = mkdtempSync(join(tmpdir(), "aiteam-spike-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const modelsPath = writeModelsJson(agentDir, faux.baseUrl);
  const modelRuntime = await ModelRuntime.create({ modelsPath, allowModelNetwork: false });
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: factories,
  });
  await loader.reload();
  const resolved = resolveCliModel({ cliModel: FAUX_MODEL_REF, modelRuntime });
  if (!resolved.model) throw new Error(`探路基建：模型解析失败 ${resolved.error ?? ""}`);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    model: resolved.model,
  });
  return {
    faux,
    cwd,
    loader,
    session,
    calls: faux.calls,
    lastCall: () => faux.calls[faux.calls.length - 1],
    close: async () => {
      try {
        session.dispose();
      } catch {
        /* 已回收 */
      }
      await faux.close();
    },
  };
}

/** 判断一条记录：探路脚本只打印结论，不引入断言框架 */
export function check(label: string, ok: boolean, detail?: unknown): boolean {
  const mark = ok ? "✓" : "✗";
  const tail = detail === undefined ? "" : ` —— ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`  ${mark} ${label}${tail}`);
  return ok;
}

export function head(title: string): void {
  console.log(`\n=== ${title} ===`);
}