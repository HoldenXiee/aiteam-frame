// 环境自检：把「这套环境里实际生效了什么」摊平给设计者看。
// 只读 loader 与 ModelRuntime 上本来就有的东西 —— 不改行为、不建 session、不写盘、不新增创建路径。
// 环境全部是**传入的**：agentDir / cwd 没有回落路径（不存在「宿主目录」这种东西），
// runtime 优先用实验室交进来的那份。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildLoader } from "./loader.ts";
import { getSharedRuntime } from "./create-agent.ts";

export interface EnvModelGroup {
  provider: string;
  /** 该 provider 目录里的模型总数（含没配凭证的） */
  total: number;
  /** 已配好凭证、现在就能用的模型 id */
  available: string[];
}

export interface EnvExtension {
  path: string;
  scope: string;
  /** 这个扩展注册的工具名（`tools` 白名单管不住自动发现的扩展，靠这里看见） */
  tools: string[];
}

export interface EnvSkill {
  name: string;
  filePath: string;
  scope: string;
}

export interface EnvReport {
  agentDir: string;
  cwd: string;
  /** 只列「有可用模型」的 provider */
  models: EnvModelGroup[];
  extensions: EnvExtension[];
  skills: EnvSkill[];
  /** 环境里的 SYSTEM.md —— 存在即整体替换系统提示词 */
  systemPromptFile?: string;
  appendSystemPromptFiles: string[];
  /** AGENTS.md / CLAUDE.md 链 */
  contextFiles: string[];
  /** 库以前静默吞掉的东西，全在这里讲出来 */
  warnings: string[];
}

/** 自检的环境：由实验室交出（`LabOptions` 的那几个字段 + 它当场定下的 runtime） */
export interface InspectEnv {
  agentDir: string;
  cwd: string;
  /**
   * 实验室成立时 agentDir 是否已存在。
   * 必须由实验室交进来：`ModelRuntime.create` 会顺手把 agentDir 建出来（实测），
   * 等 inspectEnv 再 `existsSync` 就已经看不到「不存在」这个诊断了。
   */
  agentDirExisted?: boolean;
  modelNetwork?: boolean;
  catalogBaseUrl?: string;
  /** 不传就按 agentDir + 网络开关取宿主级共享的那个（与实验室同一个） */
  modelRuntime?: ModelRuntime;
}

/**
 * 验证语句：`await lab.inspectEnv()` 回答「有哪些模型 / 插件 / 技能」。
 * 看的就是这个实验室起 agent 时真用的那套环境。
 */
export async function inspectEnv(env: InspectEnv): Promise<EnvReport> {
  const { agentDir, cwd } = env;
  const warnings: string[] = [];
  // 先记下「交进来时」的样子：buildLoader / ModelRuntime 都可能顺手把目录建出来
  const agentDirExisted = env.agentDirExisted ?? existsSync(agentDir);
  const modelsJsonPath = join(agentDir, "models.json");
  const modelsJsonExisted = existsSync(modelsJsonPath);

  const loader = await buildLoader({}, { cwd, agentDir, settingsManager: SettingsManager.inMemory({}) });
  const runtime =
    env.modelRuntime ??
    (await getSharedRuntime(agentDir, { modelNetwork: env.modelNetwork, catalogBaseUrl: env.catalogBaseUrl }));

  // 模型：快照是 ModelRuntime 建的时候填好的 —— 同步读，不联网
  const availableByProvider = new Map<string, string[]>();
  for (const m of runtime.getAvailableSnapshot()) {
    const list = availableByProvider.get(m.provider);
    if (list) list.push(m.id);
    else availableByProvider.set(m.provider, [m.id]);
  }
  const models: EnvModelGroup[] = [];
  for (const provider of runtime.getProviders()) {
    const available = availableByProvider.get(provider.id);
    if (!available?.length) continue;
    models.push({ provider: provider.id, total: runtime.getAllModels(provider.id).length, available: available.sort() });
  }

  const ext = loader.getExtensions();
  const skillsResult = loader.getSkills();

  // 诊断：静默失效在这里变成文字
  if (!agentDirExisted) warnings.push(`agentDir 不存在：${agentDir}`);
  if (!modelsJsonExisted) warnings.push(`没有 models.json（只用环境变量凭证时可忽略）：${modelsJsonPath}`);
  if (!models.length) warnings.push("没有任何配好凭证的模型：本机既无 auth.json，也没有该 provider 的环境变量");
  for (const err of ext.errors) warnings.push(`扩展加载失败 ${err.path}：${err.error}`);
  for (const w of ext.warnings ?? []) warnings.push(`扩展告警 ${w.path}：${w.warning}`);
  for (const d of skillsResult.diagnostics) warnings.push(`技能诊断${d.path ? ` ${d.path}` : ""}：${d.message}`);

  const systemPromptFile = loader.getSystemPromptSource()?.path;
  if (systemPromptFile) warnings.push(`环境里有 SYSTEM.md，它会整体替换系统提示词（<tools>/<rules>/<docs> 段消失）：${systemPromptFile}`);

  return {
    agentDir,
    cwd,
    models,
    extensions: ext.extensions.map((e) => ({
      path: e.path,
      scope: e.sourceInfo?.scope ?? "unknown",
      tools: [...e.tools.keys()],
    })),
    skills: skillsResult.skills.map((s) => ({
      name: s.name,
      filePath: s.filePath,
      scope: s.sourceInfo?.scope ?? "unknown",
    })),
    ...(systemPromptFile ? { systemPromptFile } : {}),
    appendSystemPromptFiles: loader.getAppendSystemPromptSources().map((s) => s.path),
    contextFiles: loader.getAgentsFiles().agentsFiles.map((f) => f.path),
    warnings,
  };
}
