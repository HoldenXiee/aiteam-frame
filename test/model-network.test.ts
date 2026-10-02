// AgentInit 的两个模型目录字段：`modelNetwork`（要不要联网刷目录）与 `catalogBaseUrl`（目录源）。
// 这两条钉的是 create-agent.ts 的接线（`getSharedRuntime(agentDir, { modelNetwork, catalogBaseUrl })`），
// 行为本体在 pi 的 ModelRuntime 里 —— 所以断言落在「请求打到哪 / 有没有打」与「缓存能不能恢复」上。
//
// 事实依据（pi 源码，实测确认）：
//   - `ModelRuntime.create` 里 `modelNetworkEnabled = process.env.PI_OFFLINE === undefined`（model-runtime.js:88）
//     —— `PI_OFFLINE` 是全局闸。helpers.ts 为了别的用例把它设成 "1"，所以这两例都临时撤掉它，
//     否则 `modelNetwork:false` 与 `true` 的差别会被全局闸吃掉、第一例就成了空断言。
//   - 目录请求只在 provider **有凭证**时才发（`runProviderRefreshPhase` → `resolveRefreshCredential` 为空
//     就 return），所以两份 agentDir 都写 auth.json 给内置的 anthropic 提供 apiKey —— 这样第一例的
//     「一次都没打」才是有判别力的（凭证就在那儿，只有 modelNetwork:false 能拦住它）。
//   - URL 是 `new URL("/api/models/providers/<id>", catalogBaseUrl)`（remote-catalog-provider.js），
//     假服务上正是这个端点在记 `catalogHits`。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/agent/create-agent.ts";
import { FAUX_MODEL_ID, FAUX_MODEL_REF, writeModelsJson } from "./faux-models.ts";
import { FAUX_CATALOG_MODEL_ID, FAUX_CATALOG_PROVIDER } from "./faux-server.ts";
import { faux } from "./helpers.ts";

/** 本文件专用的 agentDir：runtime 按 agentDir 缓存，跟 helpers 那个混用会串台 */
function makeAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aiteam-net-"));
  mkdirSync(dir, { recursive: true });
  writeModelsJson(dir, faux.baseUrl, [FAUX_MODEL_ID]);
  // 给内置 provider 一份凭证：没有凭证的 provider 根本不会被拉目录，两例都会退化成「什么都没发生」
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }));
  return dir;
}

/** 临时撤掉 pi 的全局离线闸（helpers.ts 一直开着它），跑完还原 */
async function withNetworkAllowed<T>(fn: () => Promise<T>): Promise<T> {
  const offline = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
  try {
    return await fn();
  } finally {
    if (offline !== undefined) process.env.PI_OFFLINE = offline;
  }
}

/** 假目录里那个 overlay 模型的完整形状（写进 models-store.json 用的） */
function catalogModel() {
  return {
    id: FAUX_CATALOG_MODEL_ID,
    name: "Faux Catalog Model",
    api: "openai-completions",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
    provider: FAUX_CATALOG_PROVIDER,
    type: "chat",
  };
}

test("modelNetwork:false：不发目录请求，但仍从 models-store.json 恢复缓存 overlay", async () => {
  const dir = makeAgentDir();
  writeFileSync(
    join(dir, "models-store.json"),
    JSON.stringify({
      [FAUX_CATALOG_PROVIDER]: {
        models: [catalogModel()],
        checkedAt: Date.now(),
        lastModified: 4102444800000, // 2100 年：比内置目录新，否则会被 localGeneratedAt 过滤掉
      },
    }),
  );
  const before = faux.catalogHits.length;
  const a = await withNetworkAllowed(() =>
    createAgent({
      agentDir: dir,
      cwd: dir,
      model: FAUX_MODEL_REF,
      modelNetwork: false,
      catalogBaseUrl: faux.baseUrl, // 万一关网没生效，请求也只会打到本机假服务上
    }),
  );
  try {
    assert.deepEqual(
      faux.catalogHits.slice(before),
      [],
      `modelNetwork:false 不该发目录请求（凭证是现成的，只有这个开关能拦住），实际打了：${faux.catalogHits.slice(before).join("、")}`,
    );
    const restored = a.model.raw.modelRuntime.getModels(FAUX_CATALOG_PROVIDER);
    assert.ok(
      restored.some((m) => m.id === FAUX_CATALOG_MODEL_ID),
      `models-store.json 里的 overlay 应当被恢复，实际 provider 下只有：${restored.map((m) => m.id).join("、") || "（空）"}`,
    );
  } finally {
    a.dispose();
  }
});

test("catalogBaseUrl 覆盖目录源：请求打到给定的 base（本机假服务）而不是 pi.dev", async () => {
  const dir = makeAgentDir();
  const before = faux.catalogHits.length;
  const a = await withNetworkAllowed(() =>
    createAgent({
      agentDir: dir,
      cwd: dir,
      model: FAUX_MODEL_REF,
      modelNetwork: true,
      catalogBaseUrl: faux.baseUrl,
    }),
  );
  try {
    const hits = faux.catalogHits.slice(before);
    assert.ok(
      hits.includes("anthropic"),
      `目录请求应当打到 catalogBaseUrl（本机假服务），实际：${hits.join("、") || "（一次都没打）"}`,
    );
  } finally {
    a.dispose();
  }
});
