// model 面：读当前模型 / 思考档 / 可用模型，换模型、换思考档。
//
// 契约（src/agent/types.ts）：`current` / `available` 是 pi 的 **Model 对象**（不是 `provider/id` 字符串），
// `thinking` 是会话的思考档。`set` 收字符串 ref（`provider/id[:thinking]`），`setThinking` 收档位。
//
// 两处「不静默」：
//   1. `set`：错模型名一律抛错（决策 #28）。pi 的 `resolveCliModel` 对不存在的模型只给 warning，
//      `session.setModel` 收到 undefined 会直接炸在别的措辞上 —— 所以解析那一步由 createAgent 注入的
//      `resolveModel`（唯一一份判据）负责，error 或 warning 都抛，且错里含用户写的那个名字。
//   2. `setThinking`：先拿 `session.getAvailableThinkingLevels()` 校验，不在里面就抛错。
//      pi 的 `setThinkingLevel` 对非法值**静默钳**到最近的可用档（spike S7 实测：`very-high` → `off`，
//      连抛都不抛）—— 调用方以为设成了 very-high，实际是 off，正是 v1 决策 #28 那类静默降级。
//
// **不加 idle 守卫**（与 `context.compact` 的 R27 不同）：spike S7 实测，运行中调 `setModel` /
// `setThinkingLevel` 都不会打断在飞的那轮 —— 两者都正常返回，那一轮照常跑完，改动从**下一次请求**起生效
// （同一轮若还在工具循环里，后半段就会用新模型 / 新思考档，负载里能看到）。调用方也察觉得到：
// `session.model` / `session.thinkingLevel` 立刻变，pi 还会发 `model_select` / `thinking_level_select`。
// 「换模型从下一次请求生效」本就是这件事的语义，拦下来只会去掉一个合法能力。
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelSurface } from "../agent/types.ts";

export interface ModelDeps {
  session: AgentSession;
  modelRuntime: ModelRuntime;
  /** ref（`provider/id[:thinking]`）→ Model；错值 / 警告一律抛错。复用 createAgent 里那唯一一份判据 */
  resolveModel: (ref: string) => Model<any>;
  assertAlive: () => void;
}

export function createModel(deps: ModelDeps): ModelSurface {
  const { session, modelRuntime } = deps;
  return {
    get current() {
      deps.assertAlive();
      return session.model;
    },
    get thinking() {
      deps.assertAlive();
      return session.thinkingLevel;
    },
    get available() {
      deps.assertAlive();
      // 同步快照（带凭证过滤后的那份）。异步的 `getAvailable()` 不是这个契约要的东西。
      return modelRuntime.getAvailableSnapshot();
    },
    async set(ref) {
      deps.assertAlive();
      // 先解析再交给 pi：pi 的 `setModel` 只认 Model 对象，而且它不会帮你找模型。
      const model = deps.resolveModel(ref);
      // pi 自己负责：写会话与设置、按新模型的能力重钳思考档、发 model_select。
      await session.setModel(model);
    },
    setThinking(level) {
      deps.assertAlive();
      const available = session.getAvailableThinkingLevels();
      if (!available.includes(level)) {
        throw new Error(
          `思考档「${level}」当前模型不支持（可用：${available.join("、")}）。` +
            "pi 的 setThinkingLevel 对非法值会静默钳到最近的可用档，所以这里自己判、不静默降级",
        );
      }
      session.setThinkingLevel(level);
    },
    get raw() {
      deps.assertAlive();
      return { session, modelRuntime };
    },
  };
}
