// model 面：读当前模型 / 思考档 / 可用模型，换模型、换思考档。
//
// 契约（src/agent/types.ts）：`current` / `available` 是 pi 的 **Model 对象**（不是 `provider/id` 字符串），
// `thinking` 是会话的思考档。`set` 收字符串 ref（`provider/id[:thinking]`，后缀会**兑现**为思考档，R45），`setThinking` 收档位。
//
// 后缀档的**校验前置、应用后置**（R45/R46）：
//   - 校验用 `getSupportedThinkingLevels(model)`（对**新**模型判），不是 `session.getAvailableThinkingLevels()`
//     —— 后者读的是 `this.model`，切模型前它还是**旧**模型，拿它判会判错。
//   - 校验必须在 `await session.setModel` **之前**：`setModel` 先写 `state.model`（agent-session.js:1885），过了这个点它自己的错误检查都已通过（`checkAuth` 在写入之前），
//     所以事后才发现档位非法就只能「模型已换 + 抛错」—— 那违反库内「被拒绝的操作不许留下半应用状态」
//     （见 resources.ts 的 commit 回滚）。现在拒绝是原子的：模型、档位都没动。
//   - 应用仍在 `setModel` **之后**：`setModel` 会拿 `_getThinkingLevelForModelSwitch` **无条件**重写思考档
//     （agent-session.js:1878-1895），先应用会被它覆盖，而且会被**旧**模型的可用档先钳掉。
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
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ModelSurface, ThinkingLevel } from "../agent/types.ts";

export interface ModelDeps {
  session: AgentSession;
  modelRuntime: ModelRuntime;
  /**
   * ref（`provider/id[:thinking]`）→ Model **以及后缀里的思考档**；错值 / 警告一律抛错。
   * 复用 createAgent 里那唯一一份判据。返回 `thinkingLevel` 是为了让 `set` 兑现后缀（R45）——
   * pi 的 `setModel` 没有思考档通道（`ModelMutationOptions` 只有 `persist`），丢了就成静默半应用。
   */
  resolveModel: (ref: string) => { model: Model<any>; thinkingLevel?: ThinkingLevel };
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
      const { model, thinkingLevel } = deps.resolveModel(ref);
      // R46：先判后缀档在新模型上合不合法，不合法就**什么都不动**地拒绝。
      // 判据必须对 **model** 判——此刻 session 上还是旧模型。
      if (thinkingLevel) {
        const supported = getSupportedThinkingLevels(model);
        if (!supported.includes(thinkingLevel)) {
          throw new Error(
            `模型「${ref}」的后缀思考档「${thinkingLevel}」它不支持（可用：${supported.join("、")}）。` +
              "模型与思考档都未改动，继续请换一个档位或用 setThinking。",
          );
        }
      }
      // pi 自己负责：写会话与设置、按新模型的能力重钳思考档、发 model_select。
      await session.setModel(model);
      // R45：兑现后缀。放 setModel 之后——它会无条件重写思考档（见文件头注释）
      if (thinkingLevel) session.setThinkingLevel(thinkingLevel);
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
