// 由 ResourceSpec 造 ResourceLoader：显式注入技能、扩展、角色，不依赖磁盘发现的偶然性（决策 #1）。
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DefaultResourceLoader,
  type InlineExtension,
  type SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import type { ResourceSpec } from "./types.ts";

export interface LoaderDeps {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  extensionFactories?: InlineExtension[];
}

/**
 * `cwd` 只影响**相对路径**的解析基准（绝对路径不看它）。默认 process.cwd() —— 这默认只对
 * 「两边都由本进程按 process.cwd() 解释」的调用者成立；凡是路径被 **pi 按 loader.cwd 解析过**的比对
 * （`spec.*` 声明的路径、运行期 add/remove 的路径），调用方**必须**传 agent 的 cwd，否则「相对路径 +
 * cwd ≠ 进程 cwd」会静默失配（资源没加载出来 / remove 误报「不是显式加进来的」）。
 */
function norm(p: string, cwd: string = process.cwd()): string {
  return resolve(cwd, p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function samePath(a: string, b: string, cwd?: string): boolean {
  return norm(a, cwd) === norm(b, cwd);
}

export function under(file: string, dir: string, cwd?: string): boolean {
  const f = norm(file, cwd);
  const d = norm(dir, cwd);
  return f === d || f.startsWith(`${d}/`);
}

/**
 * 设计者声明的扩展所提供的工具名（R41）。
 * 只认 `spec.extensions` 里显式给的那些（路径或内联工厂），**不**包括用户级/项目级自动发现的扩展 ——
 * 否则 `tools` 白名单会被环境里碰巧存在的扩展悄悄撑开，等于绕过设计者的能力裁剪。
 * （探路实测：内联工厂在 getExtensions() 里的 path 形如 `<inline:1>`。）
 * `cwd` 必须传 agent 自己的那个：pi 把 `additionalExtensionPaths` 解成相对 **loader.cwd** 的绝对路径，
 * 用 process.cwd() 去比对会让「相对路径 + 不同 cwd」的声明静默匹配不上。
 */
export function declaredExtensionToolNames(
  spec: ResourceSpec,
  loader: DefaultResourceLoader,
  cwd: string = process.cwd(),
): string[] {
  const declaredPaths = new Set(
    (spec.extensions ?? []).filter((e): e is string => typeof e === "string").map((p) => norm(resolve(cwd, p))),
  );
  return loader
    .getExtensions()
    .extensions.filter((e) => e.path.startsWith("<inline:") || declaredPaths.has(norm(e.path)))
    .flatMap((e) => [...e.tools.keys()]);
}

/**
 * 运行期可增删的注入表（R39）。三项都是**长期持有的可变引用**，`src/surfaces/resources.ts` 直接改它们：
 *   - `extensionPaths` / `skillPaths` 就是交给 pi 的 `additionalExtensionPaths` / `additionalSkillPaths` ——
 *     pi 构造期存的是**引用**（`resource-loader.js:253-254`）且每次 reload 重新读（`:364`/`:409`、`:420-424`），
 *     所以 push/splice 即可生效；
 *   - `skillObjects` 被 `skillsOverride` 读，而 `skillsOverride` **每次 reload 都调用**（`:632`）——
 *     所以运行期加第一个 Skill 对象也有路走（只在创建期有对象时才装的版本会无路可走）。
 */
export interface LoaderInjections {
  extensionPaths: string[];
  skillPaths: string[];
  skillObjects: Skill[];
  /** agent 的 cwd：路径比对要按它解析（pi 把注入路径解成相对 loader.cwd 的绝对路径） */
  cwd: string;
}

const injections = new WeakMap<DefaultResourceLoader, LoaderInjections>();

/** 取某个 loader 的注入表（只对 `buildLoader` 造出来的 loader 有效） */
export function loaderInjections(loader: DefaultResourceLoader): LoaderInjections {
  const state = injections.get(loader);
  if (!state) throw new Error("这个 loader 不是 buildLoader 造的：拿不到注入表");
  return state;
}

/**
 * 配置收敛：把 ResourceSpec 里声明的技能/扩展/角色变成 DefaultResourceLoader 的显式注入。
 * 技能名解析失败、Skill 对象指向不存在的文件 —— 一律抛错，不静默降级（决策 #2/#27）。
 * 两张路径表与 skillsOverride 都**永远**交给 pi（而不是按需）：运行期的 resources 面必须够得着它们（R39）。
 */
export async function buildLoader(spec: ResourceSpec, deps: LoaderDeps): Promise<DefaultResourceLoader> {
  const state: LoaderInjections = { extensionPaths: [], skillPaths: [], skillObjects: [], cwd: deps.cwd };
  const skillNames: string[] = [];

  for (const ref of spec.skills ?? []) {
    if (typeof ref === "string") {
      if (/\.md$/i.test(ref) || /[\\/]/.test(ref)) state.skillPaths.push(ref);
      else skillNames.push(ref);
    } else {
      if (!existsSync(ref.filePath)) {
        throw new Error(`技能「${ref.name}」的 SKILL.md 不存在：${ref.filePath}`);
      }
      state.skillObjects.push(ref);
    }
  }

  const extensionFactories: InlineExtension[] = [...(deps.extensionFactories ?? [])];
  for (const ext of spec.extensions ?? []) {
    if (typeof ext === "string") state.extensionPaths.push(ext);
    else extensionFactories.push(ext);
  }

  const loader = new DefaultResourceLoader({
    cwd: deps.cwd,
    agentDir: deps.agentDir,
    settingsManager: deps.settingsManager,
    ...(extensionFactories.length ? { extensionFactories } : {}),
    additionalExtensionPaths: state.extensionPaths,
    additionalSkillPaths: state.skillPaths,
    skillsOverride: (base) => ({
      skills: [
        // 两边都是 pi 解析过的文件路径（`b.filePath` 来自磁盘发现 / `o.filePath` 是设计者原样给的、
        // 由 `existsSync` 按 process.cwd() 校验过的），所以这里保留 process.cwd() 基准。
        ...base.skills.filter((b) => !state.skillObjects.some((o) => samePath(o.filePath, b.filePath))),
        ...state.skillObjects,
      ],
      diagnostics: base.diagnostics,
    }),
    appendSystemPrompt: spec.role ? [spec.role] : [],
  });
  injections.set(loader, state);

  await loader.reload();
  const available = loader.getSkills().skills;

  for (const name of skillNames) {
    if (!available.some((s) => s.name === name)) {
      const known = available.map((s) => s.name).join(", ") || "(无)";
      throw new Error(`找不到技能「${name}」，当前可用：${known}`);
    }
  }
  for (const ref of state.skillPaths) {
    // `ref` 是设计者原样给的路径，pi 按 loader.cwd 解析它（`updateSkillsFromPaths` → `loadSkills({cwd})`）
    const hit = /\.md$/i.test(ref)
      ? available.some((s) => samePath(s.filePath, ref, deps.cwd))
      : available.some((s) => under(s.filePath, ref, deps.cwd));
    if (!hit) throw new Error(`技能路径没能加载出任何技能：${ref}`);
  }

  return loader;
}
