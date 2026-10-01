// 模型目录联网刷新：modelNetwork / catalogBaseUrl 真的接线了吗。
// 用本机假目录（startFaux 的 GET /api/models/providers/<id>）验证，不碰 pi.dev。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgent } from "../src/agent/create-agent.ts";
import { FAUX_MODEL_REF, writeModelsJson } from "./faux-models.ts";
import { FAUX_CATALOG_MODEL_ID, FAUX_CATALOG_PROVIDER, startFaux } from "./faux-server.ts";

async function makeDir(): Promise<{ agentDir: string; baseUrl: string; faux: Awaited<ReturnType<typeof startFaux>> }> {
  const faux = await startFaux();
  const agentDir = join(mkdtempSync(join(tmpdir(), "aiteam-net-")), "agent");
  writeModelsJson(agentDir, faux.baseUrl);
  // 目录刷新只覆盖「有凭证的 provider」——没凭证的压根不会去拉。
  // （实测：不给 auth.json 时一个目录请求都不发，只写一份空 store。）
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({ [FAUX_CATALOG_PROVIDER]: { type: "api_key", key: "sk-faux" } }),
    "utf-8",
  );
  return { agentDir, baseUrl: faux.baseUrl, faux };
}

const overlayOf = (agentDir: string): any => {
  const store = JSON.parse(readFileSync(join(agentDir, "models-store.json"), "utf8"));
  return store[FAUX_CATALOG_PROVIDER];
};

test("modelNetwork: true —— 去拉目录，overlay 落盘且离线时能从缓存恢复", async () => {
  const { agentDir, baseUrl, faux } = await makeDir();
  const agent = await createAgent({
    model: FAUX_MODEL_REF,
    agentDir,
    modelNetwork: true,
    catalogBaseUrl: baseUrl,
  });
  agent.dispose();

  assert.ok(faux.catalogHits.includes(FAUX_CATALOG_PROVIDER), `应该请求过 ${FAUX_CATALOG_PROVIDER} 的目录`);
  const overlay = overlayOf(agentDir);
  assert.ok(overlay, "models-store.json 里应该有 overlay");
  assert.ok(
    overlay.models.some((m: any) => m.id === FAUX_CATALOG_MODEL_ID),
    "overlay 里应该是假目录给的那个模型",
  );

  // 共用同一个 agentDir 的另一个 runtime，关掉网络也拿得到（restore 先于 allowNetwork 判断）
  const offline = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
  assert.ok(
    offline.getAllModels(FAUX_CATALOG_PROVIDER).some((m) => m.id === FAUX_CATALOG_MODEL_ID),
    "离线时应从缓存恢复 overlay",
  );
});

test("modelNetwork: false —— 一个目录请求都不发", async () => {
  const { agentDir, baseUrl, faux } = await makeDir();
  const agent = await createAgent({
    model: FAUX_MODEL_REF,
    agentDir,
    modelNetwork: false,
    catalogBaseUrl: baseUrl,
  });
  agent.dispose();

  assert.deepEqual(faux.catalogHits, []);
});
