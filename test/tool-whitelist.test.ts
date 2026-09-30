// 白名单的能力边界：`tools` 只并入库自己提供的 customTools 与**设计者声明的**扩展工具，
// 不能把用户级/项目级自动发现的扩展工具也并进来 —— 那等于绕过设计者的裁剪。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgent } from "../src/index.ts";
import { FAUX_MODEL_REF, writeModelsJson } from "./faux-models.ts";
import { faux, seenTools } from "./helpers.ts";

const extensionSource = (tool: string) => `
export default function (pi) {
  pi.registerTool({ name: "${tool}", label: "${tool}", description: "探针工具",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
}
`;

/** 孤立的 agentDir：里面放一个「用户级扩展」，它注册一个探针工具 */
function makeIsolatedDir() {
  const root = mkdtempSync(join(tmpdir(), "aiteam-wing-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, "extensions", "user-ext.ts"), extensionSource("user_ext_probe"));
  const declaredPath = join(root, "declared-ext.ts");
  writeFileSync(declaredPath, extensionSource("declared_ext_probe"));
  return { root, agentDir, cwd, declaredPath };
}

test("tools 白名单只并入设计者声明的扩展工具，不并入用户级扩展", async () => {
  const { agentDir, cwd, declaredPath } = makeIsolatedDir();
  writeModelsJson(agentDir, faux.baseUrl);
  const modelRuntime = await ModelRuntime.create({
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });

  const declared = await createAgent(
    { model: FAUX_MODEL_REF, agentDir, cwd, tools: ["read"], extensions: [declaredPath] },
    { modelRuntime },
  );
  await declared.prompt("hi");
  const withDeclared = seenTools();
  assert.ok(withDeclared.includes("read"), JSON.stringify(withDeclared));
  assert.ok(withDeclared.includes("declared_ext_probe"), "设计者声明的扩展工具应当被并入白名单");
  assert.ok(!withDeclared.includes("user_ext_probe"), "用户级扩展的工具不该被悄悄并进白名单");

  const plain = await createAgent({ model: FAUX_MODEL_REF, agentDir, cwd, tools: ["read"] }, { modelRuntime });
  await plain.prompt("hi");
  const withoutAny = seenTools();
  assert.ok(!withoutAny.includes("user_ext_probe"), JSON.stringify(withoutAny));
  assert.ok(!withoutAny.includes("declared_ext_probe"), JSON.stringify(withoutAny));

  declared.dispose();
  plain.dispose();
});
