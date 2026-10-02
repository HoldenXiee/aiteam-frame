// 包根导出面（`src/index.ts`）：v1 的名字必须已经不在，七个面与结算的类型都能从包根 import。
import test from "node:test";
import assert from "node:assert/strict";
import * as api from "../src/index.ts";
import type {
  Agent,
  AgentInit,
  ContextSurface,
  ExtensionsSurface,
  IoSurface,
  ModelSurface,
  PermissionsSurface,
  RunResult,
  SkillsSurface,
  ToolsSurface,
} from "../src/index.ts";

// 编译期证据：这些标注全部取自包根 —— 缺哪个 `tsc --noEmit` 就红（运行期不执行任何东西）。
type PublicTypes = [
  Agent,
  IoSurface,
  ContextSurface,
  ToolsSurface,
  PermissionsSurface,
  ExtensionsSurface,
  SkillsSurface,
  ModelSurface,
  RunResult,
  AgentInit,
];
const publicTypes: PublicTypes | undefined = undefined;

test("包根导出：入口只有 v2 的两个，v1 的名字不在", () => {
  assert.deepEqual(Object.keys(api).sort(), ["createAgent", "inspectEnv"]);
  assert.ok(!("createAgentHost" in api), "v1 的 createAgentHost 不该还在");
  assert.ok(!("defineAgentTool" in api), "v1 的 defineAgentTool 不该还在");
  assert.equal(publicTypes, undefined);
});
