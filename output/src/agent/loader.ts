// 由 ResourceSpec 造 ResourceLoader：显式注入技能、扩展、角色，不依赖磁盘发现的偶然性（决策 #1）。
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DefaultResourceLoader,
  type Extension,
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
 * 资源白名单（R48）：`spec.skills` / `spec.extensions` 是**精确白名单**，不是「追加」。
 *
 * 语义（与 `permissions.only` 同构，三档）：
 *   - **字段不写** → 不过滤，环境自动发现的全部生效（向后兼容）；
 *   - **写了** → 集合就是这些：环境里其他的一律不进这个 agent 的上下文；
 *   - **写了 `[]`** → 一个都没有。
 *
 * 为什么需要它：环境（`agentDir`）是**材料池**，spec 是**选哪些**。以前的 `skills: [...]` 只会追加，
 * 于是环境里放什么就无条件进每个 agent（FACTS v1 §8 记着这个缺口：「想让某个环境里存在的扩展不生效，
 * 做不到，且零信号」）。
 *
 * 「白名单裁掉了哪些」怎么看见：对比 `lab.inspectEnv()`（环境材料池全量）与
 * `agent.skills.list()` / `agent.extensions.list()`（这个 agent 实际拿到的）—— 差集就是被裁的。
 * 没有单独的 `withheld` 字段（曾经在这里写过，但从未实现）。
 *
 * 为什么过滤在 override 里而不是构造参数：pi 的 `skillsOverride` / `extensionsOverride` 拿到的是
 * **完整 base**，返回什么就是什么（`resource-loader.js:627-641` / `:418`）——这是 pi 给的唯一切口，
 * 而且它**每次 reload 都调用**，所以运行期 `skills.add` / `extensions.add` 追加进去的东西
 * 不会被这个过滤器吃掉（它们在 base 之外，由注入表带进来）。
 */
/** 库自己的桥接工厂在 pi 里的固定 path：它是 `extensionFactories` 的第一个（匿名）工厂，即 `<inline:1>`。
 *  白名单不许裁它 —— 工具表、事件监听、审批门全靠它接回 pi。`extensionFactories: [bridge.factory]` 在
 *  `create-agent.ts` 里是**唯一**一个传给构造期的工厂，设计者自己的内联工厂在它后面（`<inline:2>` 起）。 */
const BRIDGE_EXTENSION_PATH = "<inline:1>";

interface Allowlist {
  /** undefined = 不过滤（字段没写）；有值 = 精确集合 */
  names?: Set<string>;
  /** 技能/扩展的磁盘路径（`Skill.filePath` / `Extension.path`），同样是精确集合 */
  paths?: Set<string>;
}

/** 白名单是否「一个都不给」（写了空数组）。`undefined` 与「空集」是两回事：前者不过滤，后者全裁。 */
function isEmpty(list: Allowlist | undefined): boolean {
  return list !== undefined && list.names!.size === 0 && list.paths!.size === 0;
}

/** 命中白名单就放行。`undefined` = 字段没写 = 全放行。
 *
 * 路径用 `under` 而不是相等：设计者写的是**技能目录**（`./skills/decl-skill`），而 pi 给的 `filePath`
 * 是目录里的 `SKILL.md`（实测）。相等匹配会漏掉所有目录形态的声明。
 * 名字取 `Skill.name` / 扩展没有名字（只认路径）。
 */
function allowed(list: Allowlist, name: string | undefined, path: string): boolean {
  if (name !== undefined && list.names!.has(name)) return true;
  for (const p of list.paths!) {
    if (samePath(path, p) || under(path, p)) return true;
  }
  return false;
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
 * 两张路径表与两个 override 都**永远**交给 pi（而不是按需）：运行期的 resources 面必须够得着它们（R39）。
 *
 * `spec.skills` / `spec.extensions` 是**精确白名单**（R48）：字段不写 = 环境全给，写了 = 就这些，
 * `[]` = 一个都没有。白名单**只裁环境自动发现的那部分**（base），不裁注入表 —— 所以运行期
 * `skills.add` / `extensions.add` 追加进去的东西照常生效（与 `permissions.only` 后再 `allow()` 同理）。
 */
export async function buildLoader(spec: ResourceSpec, deps: LoaderDeps): Promise<DefaultResourceLoader> {
  const state: LoaderInjections = { extensionPaths: [], skillPaths: [], skillObjects: [], cwd: deps.cwd };
  const skillNames: string[] = [];

  // 白名单：`undefined` = 字段没写（不过滤），否则是精确集合。名字与路径分开收，`Skill` 对象自带两者。
  const skillAllow: Allowlist | undefined =
    spec.skills === undefined ? undefined : { names: new Set(), paths: new Set() };
  const extAllow: Allowlist | undefined =
    spec.extensions === undefined ? undefined : { names: new Set(), paths: new Set() };

  for (const ref of spec.skills ?? []) {
    if (typeof ref === "string") {
      // 路径形态（含 .md 或路径分隔符）→ 按路径收；否则按**技能名**收（名可以指向环境里已发现的那个）
      if (/\\.md$/i.test(ref) || /[\\/]/.test(ref)) {
        skillAllow?.paths!.add(norm(ref, deps.cwd));
        state.skillPaths.push(ref);
      } else {
        skillAllow?.names!.add(ref);
        skillNames.push(ref);
      }
    } else {
      if (!existsSync(ref.filePath)) {
        throw new Error(`技能「${ref.name}」的 SKILL.md 不存在：${ref.filePath}`);
      }
      skillAllow?.names!.add(ref.name);
      skillAllow?.paths!.add(norm(ref.filePath));
      state.skillObjects.push(ref);
    }
  }

  const extensionFactories: InlineExtension[] = [...(deps.extensionFactories ?? [])];
  for (const ext of spec.extensions ?? []) {
    if (typeof ext === "string") {
      extAllow?.paths!.add(norm(ext, deps.cwd));
      state.extensionPaths.push(ext);
    } else {
      // 内联工厂：它没有磁盘路径，在 getExtensions() 里形如 `<inline:N>`（实测），
      // 所以只能把它归成「内联」一类整体放行 —— 但这也意味着它跟其他内联工厂无法分开
      extAllow?.names!.add("<inline>");
      extensionFactories.push(ext);
    }
  }

  /**
   * **实验室边界**（R49）：一个资源路径在不在这个实验室里。
   *
   * 边界 = `{agentDir}` ∪ `{cwd, cwd 的子孙}`。两个目录都是 `createLab` 必填的实验室声明，
   * 所以边界内的资源是「研究员自己放的」，边界外的是「宿主机器状态」。
   *
   * 为什么需要它：pi 的 `DefaultResourceLoader` 默认会**往上游、往宿主找**（cwd 祖先链的
   * AGENTS.md、`$HOME/.agents/skills`、git 根一路上去的 `.agents/skills`）。那些路径实验室从未声明过，
   * 却会静默进每个 agent 的 system prompt。DESIGN.md 说「电脑中的 pi Agent 的环境是不能使用的」——
   * 那就是说：不是「不主动指过去」，而是「挡住它」。
   */
  const inLab = (p: string): boolean =>
    under(p, deps.agentDir, deps.cwd) || under(p, deps.cwd, deps.cwd);

  /** 这个技能路径是不是**注入表带来**的（创建期声明或运行期 add）—— 白名单不管这些，只裁环境发现 */
  const injectedSkill = (filePath: string): boolean =>
    state.skillPaths.some((p) => samePath(filePath, p, deps.cwd) || under(filePath, p, deps.cwd));

  /** 同上，扩展版。 是 pi 解析过的绝对路径 */
  const injectedExt = (extPath: string): boolean =>
    state.extensionPaths.some((p) => samePath(extPath, p, deps.cwd) || under(extPath, p, deps.cwd));

  const loader = new DefaultResourceLoader({
    cwd: deps.cwd,
    agentDir: deps.agentDir,
    settingsManager: deps.settingsManager,
    ...(extensionFactories.length ? { extensionFactories } : {}),
    additionalExtensionPaths: state.extensionPaths,
    additionalSkillPaths: state.skillPaths,
    // 扩展：R49 边界 + R48 白名单。两者合并到一个 override 里（它**永远**装，否则边界过滤会因无白名单而失效）。
    // ⚠️ `<inline:N>` 有两类，不能一律归一类：`<inline:1>` 是**库自己的桥接工厂**
    // （`create-agent.ts` 的 `extensionFactories: [bridge.factory]`，工具/事件全靠它接线）—— 裁掉它
    // 等于把库拆了；设计者自己的内联工厂是 `<inline:2>` 起。
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((e: Extension) => {
        if (e.path === BRIDGE_EXTENSION_PATH) return true; // 库的桥接，永远在
        if (injectedExt(e.path)) return true; // 注入表（创建期声明 / 运行期 add）一律放行
        if (e.path.startsWith("<inline:")) return extAllow ? extAllow.names!.has("<inline>") : true;
        if (!inLab(e.path)) return false; // R49：边界外的环境发现一律挡掉
        return extAllow ? allowed(extAllow, undefined, e.path) : true; // R48：白名单不写就全放
      }),
    }),
    // ── R49：上下文文件（AGENTS.md / CLAUDE.md 链）──
    // pi 从 cwd 沿 `dirname` **一路走到盘根**（`resource-loader.js:184-187`），也没有任何「实验室边界」概念；
    // 于是仓库根、家目录、盘根上的 AGENTS.md 都会全文进 system prompt（实测：本仓库根的 AGENTS.md
    // 逐字进了 demo agent 的 `<project_context>` 段）。
    // 这里只留实验室边界内的：cwd 子树（含 cwd 自己的 AGENTS.md）与 agentDir 下的。
    agentsFilesOverride: (base) => ({
      agentsFiles: base.agentsFiles.filter((f) => inLab(f.path)),
    }),
    skillsOverride: (base) => ({
      skills: [
        // 两边都是 pi 解析过的文件路径（`b.filePath` 来自磁盘发现 / `o.filePath` 是设计者原样给的、
        // 由 `existsSync` 按 process.cwd() 校验过的），所以这里保留 process.cwd() 基准。
        ...base.skills
          .filter((b) => !state.skillObjects.some((o) => samePath(o.filePath, b.filePath)))
          // ① R49 边界：挡掉 `$HOME/.agents/skills` 与 cwd 祖先链上的 `.agents/skills`
          //    （pi 的 `collectAncestorAgentsSkillDirs` 只排掉 HOME 那一条，其余祖先全收）。
          // ② R48 白名单：名字或路径命中就放行（`b.filePath` 的解析基准是 process.cwd()，见 R21）。
          // ③ 注入表里的（`state.skillPaths`）一律放行：白名单只管「环境自动发现了什么」，
          //    不管「运行期 add 了什么」—— 否则 add 进去的技能会立刻被自己的 override 裁掉。
          .filter((b) => injectedSkill(b.filePath) || inLab(b.filePath))
          .filter((b) => !skillAllow || injectedSkill(b.filePath) || allowed(skillAllow, b.name, b.filePath)),
        ...state.skillObjects,
      ],
      diagnostics: base.diagnostics,
    }),
    // ── R49：prompt 模板 ──
    // `agentDir/prompts/` 与 `cwd/.pi/prompts/` 里的模板会被自动挂到 session 上，而 pi 的
    // `expandPromptTemplates` 默认 **true**（`agent-session.js:1454`）⇒ `io.prompt("/name")` 会把**模板正文**
    // 展开发给模型（实测三条投递通道全中）。spec 里连 `prompts` 字段都没有（`assertSpec` 直接拒）。
    // 实验室要模板，就该自己传进 `spec.prompts`（当前未开放）或自己拼提示词 —— 默认一个不收。
    noPromptTemplates: true,
    // ── R49：APPEND_SYSTEM.md ──
    // 原写法 `appendSystemPrompt: spec.role ? [spec.role] : []` 有个真 bug：pi 判的是
    // `if (!appendSources)`（`resource-loader.js:475-479`），而**空数组是 truthy** ⇒ 恒传 options
    // 会让 pi 的 `discoverAppendSystemPromptFile()` 永远不跑，环境里的 APPEND_SYSTEM.md
    // 被静默吃掉（实测：inspectEnv 的 appendSystemPromptFiles 恒为 []，且无任何 warning）。
    // 改法：`role` 用 `appendSystemPromptOverride` 合并到环境发现的结果之后，这样两者都不丢。
    ...(spec.role ? { appendSystemPromptOverride: (base: string[]) => [...base, spec.role!] } : {}),
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
