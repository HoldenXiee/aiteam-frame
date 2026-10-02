// extensions / skills 面：运行期增删扩展与技能，统一走「改 loader 的注入表 → reload」。
// reload 一次做两件事：`_resourceLoader.reload()`（重新读注入表）+ `_buildRuntime()`
// （agent-session.js:2867-2890）—— 所以下一轮就能看到新扩展 / 新技能。
//
// 四个注入点各走各的路（R39）——pi 的拷贝行为不同，不能一律 push 一个数组：
//   1. 扩展路径：库自己的 `extensionPaths`，就是交给 pi 当 `additionalExtensionPaths` 的那个数组，
//      pi 存引用（`resource-loader.js:253`）⇒ push/splice 即可，本文件不碰任何私有字段。
//   2. 内联工厂：pi 把构造期传入的工厂**拷成新数组**（`:245` 的 `factories.filter(...)`）⇒ 库那个数组推什么
//      都无效；真正被读的是 loader 自己的 `extensionFactories`（`:873`）⇒ 只能 cast 进私有字段。
//   3. 技能路径：同 1（`additionalSkillPaths`，`:254`）。
//   4. `Skill` 对象：走 `skillsOverride`（`:632` 每次 reload 都调用），读的是库自己的可变表。
//
// 状态全在 loader 那边（见 `LoaderInjections`），本文件只负责改表 + reload + 守卫。
import { existsSync } from "node:fs";
import type { AgentSession, DefaultResourceLoader, InlineExtension, Skill } from "@earendil-works/pi-coding-agent";
import type { Bridge } from "../agent/bridge.ts";
import { loaderInjections, samePath, under } from "../agent/loader.ts";
import type { ExtensionsSurface, SkillsSurface } from "../agent/types.ts";

export interface ResourcesDeps {
  loader: DefaultResourceLoader;
  /** 声明面 reload（自带 idle 守卫 + 扩展错误上报） */
  bridge: Pick<Bridge, "reload">;
  /** 忙判据（R29）：与 tools / permissions 面是**同一份**定义 */
  isBusy: () => boolean;
  assertAlive: () => void;
}

export interface ExtensionsDeps extends ResourcesDeps {
  /** 只给 `extensions.raw` 用 */
  session: AgentSession;
}

/** 声明面改动的前奏：存活 + idle 守卫。必须排在改表**之前** —— 被拒绝的 add/remove 不许留下半应用状态。 */
function guard(deps: ResourcesDeps): void {
  deps.assertAlive();
  if (deps.isBusy()) {
    throw new Error(
      "agent 正在运行：声明面的改动要走 reload，只有在空闲时才能改 —— 先 io.waitIdle()",
    );
  }
}

/**
 * 改注入表 → reload。reload 抛错就把表改回去（声明面不许停在半应用状态）。
 * 返回撤销函数：reload 之后还要做校验的调用方（`skills.add(路径)`）用得上。
 */
async function commit(deps: ResourcesDeps, apply: () => () => void): Promise<() => void> {
  const rollback = apply();
  try {
    await deps.bridge.reload();
  } catch (err) {
    rollback();
    throw err;
  }
  return rollback;
}

/** 往数组里加一个元素，返回「撤销这次 push」的函数 */
function push<T>(list: T[], item: T): () => void {
  const at = list.push(item) - 1;
  return () => list.splice(at, 1);
}

/**
 * pi 的 `extensionFactories` 是**私有字段**（`resource-loader.d.ts:133`），且构造期传入的工厂被 pi 拷过
 * （`resource-loader.js:245`）⇒ 库自己持有的数组推什么都没用。真正被读的是 loader 自己那个数组
 * （`:873` `this.extensionFactories.entries()`）。只能 cast —— 与 `session._allowedToolNames`
 * （FACTS #11）同类做法：由用例「extensions.add(工厂)」钉住 + 记进 FACTS。
 */
function factoryList(loader: DefaultResourceLoader): InlineExtension[] {
  return (loader as unknown as { extensionFactories: InlineExtension[] }).extensionFactories;
}

export function createExtensions(deps: ExtensionsDeps): ExtensionsSurface {
  const { loader, session } = deps;

  return {
    list() {
      deps.assertAlive();
      return loader.getExtensions().extensions;
    },

    /** 加载期错误（路径不存在 / 扩展加载抛错）。运行期的钩子异常不走这里，由库的 onError 监听器上报 */
    errors() {
      deps.assertAlive();
      return loader.getExtensions().errors;
    },

    /** 碰声明面 → async（reload），要求 idle。路径落库自己的路径表，内联工厂落 loader 自己的工厂表 */
    async add(extension) {
      guard(deps);
      if (typeof extension === "string") {
        const paths = loaderInjections(loader).extensionPaths;
        await commit(deps, () => push(paths, extension));
        return;
      }
      const factories = factoryList(loader);
      await commit(deps, () => push(factories, extension));
    },

    /** 只认显式加进来的路径（创建期 `spec.extensions` 与运行期 `add`）；环境自动发现的不在表里 */
    async remove(path) {
      guard(deps);
      const list = loaderInjections(loader).extensionPaths;
      const at = list.findIndex((p) => samePath(p, path));
      if (at < 0) {
        throw new Error(
          `扩展「${path}」不是本库显式加进来的扩展路径（内联工厂与环境自动发现的扩展都不归这里管）——` +
            "显式加进来的见 extensions.list()",
        );
      }
      await commit(deps, () => {
        const [removed] = list.splice(at, 1);
        return () => list.splice(at, 0, removed!);
      });
    },

    get raw() {
      deps.assertAlive();
      return { loader, session };
    },
  };
}

export function createSkills(deps: ResourcesDeps): SkillsSurface {
  const { loader } = deps;
  const state = () => loaderInjections(loader);
  const loaded = () => loader.getSkills().skills;

  return {
    list() {
      deps.assertAlive();
      return loaded();
    },

    /** 碰声明面 → async（reload），要求 idle。只接受路径或 `Skill` 对象 */
    async add(skill: string | Skill) {
      guard(deps);
      if (typeof skill !== "string") {
        // 决策 #27：虚拟 filePath 会在 pi 的 `getDefaultSourceInfoForPath` 里 ENOENT 崩掉
        if (!existsSync(skill.filePath)) {
          throw new Error(`技能「${skill.name}」的 SKILL.md 不存在：${skill.filePath}`);
        }
        const objects = state().skillObjects;
        await commit(deps, () => push(objects, skill));
        return;
      }
      // 裸名字（含空串）没有意义：技能是**被环境发现**的，不是在运行期按名注册的
      if (!/\.md$/i.test(skill) && !/[\\/]/.test(skill)) {
        throw new Error(
          "skills.add 只接受路径（技能目录或 SKILL.md）：技能是环境发现的，按名字加没有意义。" +
            "要看当前有哪些技能用 skills.list()",
        );
      }
      const paths = state().skillPaths;
      const rollback = await commit(deps, () => push(paths, skill));
      // 表改了但一个技能都没加载出来 = 静默无效果（目录里没有 SKILL.md、或 SKILL.md 不合法）。
      // 与 buildLoader 对创建期路径的判据一致：不静默降级（决策 #2/#27）。
      if (!loaded().some((s) => samePath(s.filePath, skill) || under(s.filePath, skill))) {
        rollback();
        throw new Error(`技能路径没能加载出任何技能：${skill}（目录里要有 SKILL.md）`);
      }
    },

    /** 只认显式加进来的（创建期 `spec.skills` 与运行期 `add`）；环境自动发现的删不掉 */
    async remove(path) {
      guard(deps);
      const { skillPaths, skillObjects } = state();
      // `under(path, p)`：加进来的是目录、调用方按技能的 SKILL.md 文件路径来删，也算删它
      const at = skillPaths.findIndex((p) => samePath(p, path) || under(path, p));
      if (at >= 0) {
        await commit(deps, () => {
          const [removed] = skillPaths.splice(at, 1);
          return () => skillPaths.splice(at, 0, removed!);
        });
        return;
      }
      const objAt = skillObjects.findIndex((o) => samePath(o.filePath, path));
      if (objAt >= 0) {
        await commit(deps, () => {
          const [removed] = skillObjects.splice(objAt, 1);
          return () => skillObjects.splice(objAt, 0, removed!);
        });
        return;
      }
      throw new Error(
        `技能「${path}」不是本库显式加进来的（环境自动发现的技能删不掉）。显式加进来的见 skills.list()`,
      );
    },

    get raw() {
      deps.assertAlive();
      return loader;
    },
  };
}
