// 包根导出面（`src/index.ts`）：唯一入口是实验室，v1/v2 的顶层出口都不在，七个面与结算的类型都能从包根 import。
import test from "node:test";
import assert from "node:assert/strict";
import * as api from "../../src/index.ts";
import type {
  Agent,
  AgentSpec,
  ContextSurface,
  EnvReport,
  ExtensionsSurface,
  IoSurface,
  Lab,
  LabOptions,
  ModelSurface,
  PermissionsSurface,
  RunResult,
  SkillsSurface,
  ToolsSurface,
} from "../../src/index.ts";

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
  AgentSpec,
  Lab,
  LabOptions,
  EnvReport,
];
const publicTypes: PublicTypes | undefined = undefined;

test("包根导出：启动入口只有实验室一个（createAgent / inspectEnv 都不在顶层）", () => {
  // `createSandbox` 不属于「启动入口」—— 它造的是一个**工具**（与 pi 的 defineTool 同级），
  // 不进 lab、不建 agent，也不构成第二条创建路径。所以它可以在顶层。
  // 这条用例真正守的是「agent 只能由实验室启动」这个类型上的事实，不是“顶层只能有一个函数”。
  assert.deepEqual(Object.keys(api).sort(), ["createLab", "createSandbox"]);
  assert.ok(!("createAgent" in api), "v1/v2 的顶层 createAgent 已被实验室取代");
  assert.ok(!("inspectEnv" in api), "环境自检挂在实验室上，不再是顶层出口");
  assert.equal(publicTypes, undefined);
});

