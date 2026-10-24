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
  // ★★★ 2026-10-21：这条不变式**没有被放宽**，只是把「不是启动入口」的导出列清。
  //
  //   守的东西没变：**agent 只能由实验室启动**。
  //   ★ 新增的几个（`openRunLog` / `verifyRunLog` / `getLibRevision` …）都**不建 agent**、
  //     不进 lab —— 它们是 provenance 工具（判据指纹 / 篡改检测），与 `createSandbox` 同级。
  //   ★★ 所以改成「显式白名单」：多一个导出就必须在这里登记并说明它为什么不构成第二条启动路径。
  const STARTERS = ["createLab", "createSandbox"];
  const NON_STARTERS = [
    // ★ provenance 工具（2026-10-21 从 hunt 私有副本并入 src/runlog.ts）
    "openRunLog",
    "freezeCriteria",
    "verifyRunLog",
    "verifySealedRow",
    "sha12File",
    "shaFile",
    "canonicalJson",
    "getLibRevision",
    "getEnvRevision",
  ];
  assert.deepEqual(
    Object.keys(api).sort(),
    [...STARTERS, ...NON_STARTERS].sort(),
    "★ 顶层导出的集合变了 —— 若是新的启动入口，那是不允许的；若只是工具，请登记到 NON_STARTERS",
  );
  // ★ 真正的不变式：造 agent 的入口只有 createLab
  assert.ok("createLab" in api, "实验室必须在");
  assert.ok(!("createAgent" in api), "v1/v2 的顶层 createAgent 已被实验室取代");
  assert.ok(!("inspectEnv" in api), "环境自检挂在实验室上，不再是顶层出口");
  // ★ 白名单里的每一个都**不许**是造 agent 的函数
  for (const k of NON_STARTERS) {
    assert.ok(!/^(create|start|spawn|launch|make|new)/.test(k), `★ ${k} 看起来像启动入口，不该在 NON_STARTERS 里`);
  }
  assert.equal(publicTypes, undefined);
});

