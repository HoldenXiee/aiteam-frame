# aiteam 实现事实：已实测核对的实现决策

- 日期：2026-10-01
- 性质：**事实**。记录库为什么长成现在这样，每条决策当初都实跑核对过。
- 标 † 的行在后续审计中被**更正或限定了口径**，正文已写成更正后的形态；更正依据见文末。

---

## 1. 依赖与配置收敛

| # | 决策 | 理由 |
|---|---|---|
| 1 | 自己构造 `DefaultResourceLoader`，用 `additionalSkillPaths` / `extensionFactories` / `additionalExtensionPaths` / `appendSystemPrompt` **显式注入**，不依赖磁盘发现 | 理由不是「绕开 trust」（探路已证伪：SDK 路径下 `projectTrusted` 默认就是 `true`），而是**确定性**：注入什么就是什么，不受磁盘布局与 cwd 影响 |
| 2 | skill 名字解析：建 loader + `reload()`，用 `getSkills().skills` 做名字 → Skill 映射；找不到**抛错**，不静默降级 | 静默降级会让运行时行为不可预测。注意 0.99.1 的 `getSkills()` 返回 `{ skills, diagnostics }` 而**不是**数组 |
| 3 | 模型解析直接用导出的 `resolveCliModel({ cliModel, modelRuntime })`，不自造 | 已支持 `provider/id:thinking` 语法。但它对不存在的模型只给 `warning` 不报错，库必须自己判（见 #28） |
| 17 | 依赖版本固定为 `@earendil-works/pi-coding-agent@0.99.1` | 所有 API 与决策均针对该版本实跑核对过 |
| 28 | `resolveCliModel` 返回的 `warning` 必须自己处理，不得忽略 → 库把它转成**抛错** | 实测：不存在的模型返回 `model` **仍然有值** + `warning: 'Model "nope" not found ... Using custom model id'`。直接信任 `model` 会把拼写错误变成静默的奇怪行为 |
| 29 | 依赖必须**显式声明**：至少 `@earendil-works/pi-coding-agent` + `typebox`；要用 `Usage` 还需 `@earendil-works/pi-ai` | 三者中只有 pi-coding-agent 是顶层依赖，`typebox` 与 `pi-ai` 都只是它的嵌套依赖，**从项目根不可解析**。不加 `typebox` 连工具定义都写不出来 |

## 2. 配置优先级与资源隔离

| # | 决策 | 理由 |
|---|---|---|
| 8 | `ModelRuntime` 由宿主共享、**按 `agentDir` 缓存**、可注入 | 每 agent 一个会重复读盘并重复刷新模型目录；但全局只留一个会让第二个不同 `agentDir` 的分身读到**第一个**的 `models.json` / `auth.json`（实测复现：表现为「模型找不到」，报错还指向模型名） |
| 9 | `agentDir` 默认宿主级共享 | 每 agent 一个会让 `auth.json` 凭证需要重复配置 |
| 13 | `host.defaults` 是所有成员的基线，被成员定义覆盖；优先级为 `host.defaults` ← `members[x]` ← 顶层 `spec`，浅合并覆盖（数组整体替换，不拼接） | 避免「默认值只管子 agent」这种需要读源码才能明白的语义 |

## 3. 创建与工具接线

| # | 决策 | 理由 |
|---|---|---|
| 4 † | 仅当 `spec.tools` **非空**时才把 customTools 与**设计者声明的**扩展工具名并入白名单；`tools: []` 表示一个工具都不给；完全未提供则不动白名单 | customTools **不需要**列进 `tools`——白名单非空时库**强制并入**它的名字，白名单**关不掉** customTool，要关只能用 `excludeTools`。需要设计者在 `spec.extensions` 里声明的只有**扩展**工具名；环境里自动发现的扩展不算，否则用户级 `.pi/extensions` 会把白名单悄悄撑开。`tools: []` 走真值判断会被吃掉，所以判据用 `?.length` |
| 10 | `onToolCall` 实现为动态生成的扩展工厂：`extensionFactories: [pi => pi.on("tool_call", …)]` | 这是 pi 拦截工具调用的标准做法，返回 `{ block: true, reason }` |
| 11 | 工具是工厂式（接受 `ctx`），静态对象也支持 | 挑选型工具必须拿到调用者上下文；简单工具不必被强迫包一层 |
| 12 | 工具工厂的 `ctx` **惰性求值**（可变 holder 注入） | 实测：工具 `execute` 拿到的 `ctx` 是 SDK 的 `ExtensionToolContext`，**不含当前 agent 引用**。而 `customTools` 在 `createAgentSession` 时就交给 SDK，那时 `ControlledAgent` 尚未构造完成。这不是优化而是必需 |
| 27 | `skills` 里的 `Skill` 对象必须指向**真实存在**的文件 | 实测：虚拟 `filePath` 会在 `getDefaultSourceInfoForPath` 里 `ENOENT` 崩掉。按名字解析也必须走磁盘上的真技能 |

## 4. 会话与运行时

| # | 决策 | 理由 |
|---|---|---|
| 5 | `RunResult.error` 显式暴露 | pi 的 `prompt()` 在**接受后**失败是通过事件流报告的，不 reject。不暴露的话调用方会误判成功 |
| 6 | `RunResult.usage` = 本次运行；`ControlledAgent.usage` = 全生命周期累计 | 两者都叫 usage 极易误用，必须在类型注释与文档里写死语义 |
| 7 | 事件归一化只对外暴露 7 个 + `session` 逃生口；载荷用 `AgentEventMap` 收窄 | 全透传等于没封装；`unknown` 会逼用户到处 cast |
| 25 | **`role` 用 `appendSystemPrompt` 实现**，不用 `systemPrompt` 也不用 `systemPromptOverride` | 实测：`systemPromptOverride(base)` 的 base 是 `systemPrompt` **选项的值**，不是 pi 内置默认提示词；`systemPrompt` 是整体替换，会把 `<tools>` 段一起换掉。`appendSystemPrompt` 保留默认行为，角色说明追加在 `<tools>` 之后、`<available_skills>` 之前 |

## 5. 投递、等待与生命周期

| # | 决策 | 理由 |
|---|---|---|
| 18 | **`send()` 是必需的一层，不是便利方法** | pi 的 `prompt()` 在目标 streaming 且无 `streamingBehavior` 时**直接抛错**。团队场景里目标正忙是常态，不补这层，消息功能一写就崩 |
| 19 | `send()` 忙时用 `followUp`（mode `next`）/ `steer`（mode `interrupt`）排队，空闲时直接 `prompt` | 投递者不应被迫关心目标当前是否在忙 |
| 26 † | `send()` 必须自己分派状态：`running > 0 \|\| isStreaming` → `steer` / `followUp`，否则 → `prompt` | 空闲时 `steer()` **不是静默丢弃**，而是**静默停放 + 下一次 `prompt()` 被唤醒并顶替那次 prompt 的返回文本**（请求数不变，但那条消息会在几秒后另一个业务分支里冒出来偷走结果）。忙时 `prompt()` 抛错并要求 `streamingBehavior`。只看 `isStreaming` 不够——它要等 `session.prompt()` 内部几个 await 才翻真，而 `send()` 是先发起再返回，启动窗口里的第二次投递会再调一次 `prompt()` 被拒，消息没跑却谎报 `ran`。所以库自己维护「有几个跑在飞」 |
| 23 | `send()` 不带回复通道，用 `agent.lastResult` 配合 | 带回复的 `send` 就是同步 `ask`，会把死锁引进来。督导等场景只需「投递 → `waitForIdle()` → 读 `lastResult`」 |
| 21 | `waitForIdle()` 包裹 `session.waitForIdle()`，且已 `dispose` 时直接 resolve | 调用方不该为了等待穿到逃生口；已回收的 agent 永远「已静下来」 |

## 6. 拓扑、护栏与归属

| # | 决策 | 理由 |
|---|---|---|
| 14 | 深度由 `parent` 链推出，**不作为参数传入** | 可被伪造的参数等于没有护栏 |
| 15 | 分身在 `spawn_agent` 返回后**保留**在宿主中 | 后续的 `send_message(id)` / 等待 / 聚合都需要 id 与存活实例 |
| 16 | `spawn_agent` 的 `member` 用**枚举约束** + 描述**动态列出花名册** | 模型在类型层面就无法请求不存在的成员；不列出来，agent 也无从挑选 |
| 20 | `send_message` 只能投递给**自己的后代分身** | 防跨分支干扰；后代关系是树，禁止反向投递就**免费消灭发送环** |
| 22 | **宿主只提供机制，不固化策略**：发射 `agent_created` / `agent_disposed` / `round_completed`，但**不内置**轮次上限或督导逻辑 | agent 自己组织循环时设计者看不到循环体，**不给观测就是瞎的**；但轮次督导只是众多监控需求之一，写进 L1 既伤灵活性又多写代码 |
| 24 † | 不做轮次硬上限 | 「轮次上限 + 督导 agent」是一种可用方案，不是唯一方案；硬上限会阻止合法的长任务。统一由 `budgetTokens` 兜底，需要更早干预时用 #22 的事件 |

## 7. 模型目录与环境自检

| # | 决策 | 理由 |
|---|---|---|
| 30 | `modelNetwork` 默认 **true**（与 CLI pi 行为一致），`catalogBaseUrl` 可覆盖目录源；两者都进 `ModelRuntime` 缓存 key | pi.dev 的 overlay（`withRemoteCatalog`）已经内置，库只差把 `allowModelNetwork` 传下去。缓存 key 必须带开关：否则第一个 runtime 的设置会决定后面所有分身（与 #8 同类）。开关放 `MemberSpec`，宿主级配置走 `host.defaults`（#13） |
| 31 | `inspectEnv()` 只读、不建 session、**不是第二条创建路径** | 环境里自动发现的东西会静默生效（#4 的 E7/E8、`SYSTEM.md` 整体替换提示词、`~/.agents/skills`）。把「实际生效了什么」讲出来，比再加一层配置抽象便宜得多 |
| 32 | 测试一律 `PI_OFFLINE=1` | 冷 `models-store.json` + `modelNetwork: true` 实测 +2.2s（42 个 provider，只拉有凭证的那几个）；离线环境更久。`PI_OFFLINE` 是 SDK 提供的总闸 |

三条实测定下来的事实（不是推测）：

- **目录刷新只覆盖「有凭证的 provider」**：临时 agentDir 里不放 `auth.json` 时，一个目录请求都不发，只写一份空 store。所以「实时更新」的前提是凭证已配（CLI `/login` 或环境变量）。
- **overlay 的恢复先于允许联网的判断**：`modelNetwork: false` 也会从 `<agentDir>/models-store.json` 恢复缓存。跟 CLI pi 共用 `agentDir` ⇒ 白拿 CLI 拉过的更新。
- **`opencode-go` 本就是内置 provider**（pi 0.99.1：29 个模型，`minimax-m3` / `qwen3.8-flash` 已内置路由到 `anthropic-messages`）。`pi-opencode-provider` 那类插件的增量只剩「不等 pi.dev 目录」，**不移植**。

## 8. 由上述决策推出的、值得记住的边界

- `tools` 是唯一受声明管辖的白名单。`extensions`（加载）与 `skills`（注入）**不受**声明控制——想让某个环境里存在的扩展不生效，做不到，且零信号。
- 白名单非空 ⇒ customTools **强制生效**。
- 「发出去的消息」与「拿回来的结果」之间**没有绑定**：`RunResult` 是共享消息池的排干结果。要拿到与调用绑定的结果，只能靠 `prompt`（链内）、或 `send` + `waitForIdle`、或自己按 `session.messages` 长度做游标切片。

---

## 更正依据

| † | 原说法 | 更正后 | 出处 |
|---|---|---|---|
| #4 | 「不把 `customTools` 列进 `tools` 就静默不生效」 | **相反**：白名单非空时 customTools **强制并入**，白名单关不掉它，只能靠 `excludeTools` | `audit/06-failures` + 源码 |
| #26 | 搬自探路：空闲 `steer()` **静默丢弃**消息 | **静默停放**：下次 `prompt()` 时被唤醒并**顶替那次 prompt 的返回**（比丢弃更难查） | 三个独立来源 |
| #24 | 预算兜底 | 框定不完整：`budgetTokens` 实测是**轮前软约束**——单轮不封顶、忙时 `followUp`/`steer` 完全绕过（实测击穿 5.0×） | `audit/verify-budget-bypass.ts`、`audit/04-guards` |

其余经审计**维持原判**，包括两处曾被怀疑但复核后否定、以及一处影响为零的：

- `depthOf` 的 O(n²) **实践影响为零**：每层恒 1.4ms（n=64→512），被 `createAgentSession` 常数项淹没。
- `temperature` 等采样旋钮**在 SDK 上可达**，只是库没接——不是「结构上做不到」。
- 「`dispose` 会把 `session.messages` 清空」**是错的**：原样本是「建完就 dispose、从未 prompt」，0 是「本来就没有」。

---

## v2 探路实测（2026-10-02）

对应 [v2 规格](superpowers/specs/2026-10-02-runtime-surfaces-design.md) §7。全部在本机假 provider 上跑，零 API 成本；脚本在 `spike/`，完整输出与复现命令见 [`spike/FINDINGS.md`](../spike/FINDINGS.md)。

| # | 事实 | 出处 |
|---|---|---|
| 1 | 把工具塞进内存表 + `session.reload()`，工具会进 `getActiveToolNames()`、进模型收到的 schema、能被执行；`remove` + reload 后从声明面消失 | `spike/s1-tool-reload.ts` |
| 2 | `context` 钩子改的是**本轮发给模型的**，逐轮生效、不动历史；pi 传的是**副本**，原地改 `event.messages` 不污染 `session.messages`；钩子拿到的是**不含 system** 的消息 | `spike/s2-context-hook.ts` |
| 3 | **`reload()` 在 streaming 中不抛错**，约 7ms 静默返回，在飞那轮照常跑完 ⇒ 「必须 idle」只能由库自己守 | `spike/s3-reload-while-running.ts` |
| 4 | reload 之后桥接的钩子**完整复活且可反复**；running 中 reload 会发 `session_shutdown(reason:"reload")` | `spike/s3b-hooks-after-reload.ts` |
| 5 | 同一事件的多个 handler **按注册顺序链式执行**，跨扩展顺序 = 扩展工厂注册顺序；返回 `{block:true}` **短路**（同扩展后续 handler 与其他扩展全收不到）；返回 `undefined` **不覆盖**前一个有效结果 | `spike/s4-handler-merge.ts` / `s4b-transform-merge.ts` |
| 6 | pi 的 `ExtensionContext` 是对象字面量，`abort` / `compact` / `isIdle` / `getContextUsage` / `getSystemPrompt` / `hasPendingMessages` / `shutdown` / `isProjectTrusted` 全是**自有属性且不依赖 `this`** ⇒ `{...ctx, agent, runId}` 可直接用，不需要 Proxy | `spike/s5-ctx-shape.ts` |

以上这些对 v1 的结论**没有更正**——它们是 pi 层的新事实，v1 未触碰这些面，所以**单独成段**（下表接续编号，与上面 v1 编号无关）。

| 7 | pi 用 `hasHandlers(eventType)` 决定走不走扩展分支（17 处：`tool_call` / `turn_end` / `input` / `agent_before_settle` / `before_provider_request` 等）。**但给全部 41 个 `on()` 事件挂 no-op handler 后，请求次数、messageCount、tools 声明、system 长度、会话消息序列、产出文本、报错全部与「无扩展」基线一致**；`compact()` 走的正是被守卫的压缩分支，两边结局同样一致 | `spike/s6-all-events.ts` / `s6b-compaction.ts` |
| 8 | **`session.compact()` 的第一行是 `await this.abort()`**（`agent-session.js:2101`）——运行中调用它会**静默 abort 在飞的那一轮**；会话太小时还会抛 `Nothing to compact (session too small)`（`:2120`）。所以库的 `context.compact()` 必须自带 idle 守卫，真直通留给 `raw` | v2 任务 3 实现者披露 + 源码核实 |
| 9 | `session.reload()` 会 `new ExtensionRunner(...)`（`agent-session.js:2852`），**挂在 runner 实例上的监听器随旧实例一起死**（`_applyExtensionBindings` 只重挂 `bindExtensions` 存到 session 上的那个）⇒ 库的错误监听器必须 re-arm | v2 任务 1 复审实测 |
| 10 | pi 的 `emitError` 只遍历 `errorListeners`、**没有 console 兜底**（`runner.js:497-501`），而 `createAgentSession` 不注入 `onError` ⇒ 不注册监听器 = 钩子异常彻底静默（`emitContext` 等会 catch 进 `emitError`） | v2 任务 1 实现者披露 + 源码核实 |
| 11 | `session._allowedToolNames` 是**私有字段**，pi 无公开增删白名单的 API（`allowedToolNames` 只是构造期 config，经 `createAgentSession({tools})`，`sdk.js:145`）。白名单是**硬过滤**：`agent-session.js:2745-2760` 过滤注册表 + `:2799` 过滤活跃集 ⇒ 运行期加一个工具**必须**把名字并入该私有集，否则它在声明面被**静默丢弃**；只调 `setActiveToolsByName` 过不了 2799。 | v2 任务 4 审查（第一手复现：去掉并入 → 恰好「白名单+add」用例红） |
| 12 | `getDefaultTools()` 在 pi 全 dist **仅 `sdk.js:144` 一处消费**，且是 `options.tools ?? (configuredDefaultToolNames ?? DEFAULT_TOOL_NAMES)` ⇒ 只要传了 `tools`，`defaultTools` **永不生效**。（库因此不接它：接了就是配着假理由的死代码。） | v2 任务 4 审查（全 dist 检索 + 源码行） |
| 13 | `reload()` 会重算活跃集：`_buildRuntime({activeToolNames: getActiveToolNames(), includeAllExtensionTools: true})` + `_refreshToolRegistry`（`agent-session.js:2741-2822`）两条分支——白名单非空时「凡在白名单且 declarable 的注册名一律推入，**不看 defaultActive**」（`:2800-2806`）；无白名单时「declarable 且 `defaultActive !== false`」（`:2808-2816`，`_isActivatedOnRegistration` 在 `:2829-2830`）⇒ **任何声明面操作都会重算活跃集**，运行期用 `setActiveToolsByName` 做的收紧会被下一次 reload 抹掉。 | v2 任务 4 审查（源码行 + 临时副本探针） |
| 14 | `setActiveToolsByName` 走 `_applyToolLoadout`（`agent-session.js:1075/1098-1102`）：去重 + 注册表查找 + 非 hidden，**没有 defaultActive 过滤** ⇒ 它是唯一能把 `defaultActive:false` 的工具**显式激活**的通道。 | v2 任务 4 审查（临时副本探针） |
| 15 | 除白名单外还有一张**排除集** `_excludedToolNames`（创建期参数 `excludeTools`，`sdk.js:146`）；两集合在 `_refreshToolRegistry` 里合成同一个 `isAllowedTool`（`agent-session.js:2747` 定义，`:2755/2757/2787` 过滤注册表、`:2799` 过滤活跃集）⇒ 运行期 `deny` 要抗过 reload，要么从白名单里删（有白名单时）要么把名字记进排除集（无白名单时）——后者比「把当前允许的名字物化成白名单」安全：不会连带关掉别的扩展事后注册的工具。 | v2 任务 5 实现（源码行 + 用例判别力） |
| 16 | `setActiveToolsByName` **只在注册表里找**名字（`_applyToolLoadout`，`agent-session.js:1098-1102`）⇒ 被创建期白名单筛掉的名字（连注册表都没有）无法靠它立即启用。**pi 事实不变；但库不再暴露这个天花板**：R38 把 `permissions.only/allow/deny` 从「同步只改活跃集」改成 async + `reload()`（reload 重建注册表 + 重算活跃集，一步到位），同步语义连同天花板一起删了。 | v2 任务 5 实现（实测：`only:["read"]` 创建后再 `allow(["bash"])`，改 reload 前立即不生效、reload 后才生效；任务 5 审查后按 R38 改契约，天花板消失） |
| 17 | 三个「注入点」在 pi 里的**拷贝行为不同**（`dist/core/resource-loader.js`）：`additionalExtensionPaths` / `additionalSkillPaths` 构造期 `?? []` **存引用**（`:253-254`）且每次 reload 重读（`:364`/`:409`、`:420-424`）⇒ 库长期持有自己的数组并 push/splice 即生效；但 `extensionFactories` 被 `factories.filter(...)` **拷成新数组**（`:245`），库自己的数组推什么都没用，真正被读的是 loader 自己那个数组（`:873` `this.extensionFactories.entries()`，即 `<inline:N>` 的 N = 下标+1）⇒ 运行期加内联工厂只能 cast 私有字段（`resource-loader.d.ts:133`），与 #11 同类：由用例「extensions.add(工厂)」钉住（mutation：push 进副本 → 恰好该用例 + list 用例红）。 | v2 任务 6 实现（源码行 + mutation 判别力） |
| 18 | `skillsOverride` 是**每次 reload 都调用**的（`resource-loader.js:632`，`updateSkillsFromPaths` 里）⇒ 运行期加 `Skill` 对象只需让 override 读一张可变表；只在「创建期有 Skill 对象」时才装 override 会让运行期加第一个对象**无路可走**（mutation：改回条件安装 → 恰好「skills.add(Skill 对象)」用例红）。库因此**永远**装它。 | v2 任务 6 实现（源码行 + mutation 判别力） |
| 19 | `LoadExtensionsResult.errors`（`{path, error}`）是**加载**错误：除扩展自身加载失败外，`additionalExtensionPaths` 里不存在的路径每次 reload 都会被记一条（`resource-loader.js:409-417`）。它与 pi 的 `ExtensionError`（`{extensionPath, event, error, stack?}`，运行期钩子异常，见 #1/#10）是两回事 ⇒ `extensions.errors()` 只能返回前者（R40 更正了契约里写错的那个类型）。 | v2 任务 6 实现（R40 + 实测：坏路径创建成功、errors 恰 1 条） |
| 20 | pi 的 `reload()` 每次都会做：`session_shutdown(reason:"reload")` + 丢弃旧 runner（全部扩展工厂**重跑**）+ `settingsManager.reload()` + `resetApiProviders()` + `_buildRuntime` + 有绑定时再发 `session_start(reason:"reload")`（`agent-session.js:2866-2890`）⇒ **一次库内 add 调用可能让工厂与生命周期事件跑两遍**（R41 双趟 reload）。`<inline:N>` 的 N 是稳定下标（`resource-loader.js:874` `index + 1`），不会漂移；`extensionsResult` 每次 reload 整体重建（`:418`），故 `list()` 无重复项。 | v2 任务 6 审查（逐行核实安装包源码） |
| 21 | `skillsOverride` 返回的 Skill 对象里，**相对 `filePath` 的权威解析基准是 `process.cwd()`**：pi 消费 `skill.filePath` 只经 `findSourceInfoForPath`/`getDefaultSourceInfoForPath`，而前者是 `resolve(resourcePath)`——**单参 resolve**（`resource-loader.js:715`），没有 loader.cwd 参与。而**注入路径**（`additionalSkillPaths`/`additionalExtensionPaths`）走的是 `resolveResourcePath` = `resolvePath(p, this.cwd)`（`:794-795`，即 **agent cwd**）。**两个基准不是同一个**——混用会静默失配。 | v2 任务 6 复审（逐行核实安装包源码） |
| 22 | **运行中调 `setModel` / `setThinkingLevel` 不打断在飞那轮**（不 abort、不抛、不吞结果），改动从**下一次请求**起生效；同一轮若还在工具循环里，**后半段就已是新模型/新档**（负载 `"echo"→"echo-alt"`、`reasoning_effort:"high"`）。调用方可察觉：`session.model`/`session.thinkingLevel` 立刻变，pi 发 `model_select`/`thinking_level_select`。（与 `compact()` 首行 `await this.abort()` 形成对照——那才是必须加 idle 守卫的原因。） | v2 任务 7 spike S7 实测 |
| 23 | `session.setThinkingLevel(非法值)` **静默钳**到最近的可用档（`very-high` → `off`），连抛都不抛；`getAvailableThinkingLevels()` 只反映**当前模型**：假模型 echo（`reasoning:false`）⇒ 只有 `["off"]`；echo-alt（`reasoning:true` 且**无 `thinkingLevelMap`**）⇒ `["off","minimal","low","medium","high"]`（5 档，`xhigh`/`max` 因无显式映射被滤掉）。要**对另一个模型**判合法性，不能问 session（它答的是当前模型），要用 `getSupportedThinkingLevels(model)`（pi-ai 主入口导出）。 | v2 任务 7 spike S7 实测 |
| 24 | `faux.calls[i].model` 是**模型 id**（`echo`），不是 `provider/id`（`faux/echo`）——假服务记的是原始负载（`test/faux-server.ts:96` `model: payload.model`），而负载里只放 id。 | v2 任务 7 实现者实测 |
| 25 | pi 的派发对所有事件用**真值判据**（`if (!handlerResult) continue`），而它全部 `handlerResult` 消费点都**解构对象字段**（runner.js 逐行核实：`:1009`/`:1034` 要 `.messages`，`:1070-1072` 对任何非 undefined 返回**整体替换 payload**）——**没有任何事件接受非对象变换结果**。pi 自己只对 `user_bash` 做形状校验（runner.js:975），对 `before_provider_request` **不设防**。`on("before_provider_request", (e) => arr.push(e))` 因此会被当成变换结果 ⇒ payload 被整体替换 ⇒ 0 条消息的请求 ⇒ 静默重试 ⇒ **空文本、耗时 14 秒、无任何报错**（任务 8 探针实测 14265ms、provider 被调 4 次）。⇒ 本库加 R47 守卫（非对象真值即抛错）。 | v2 任务 8 审查（逐行核实）+ 探针实测 |
| 26 | 扩展钩子里抛出的异常**不会穿出 `session.prompt`**：pi 把它交给 `emitError` 通路（`runner.js`），本库 R17 装在 `extensionRunner.onError` 上转成 `[aiteam]` 前缀的 `console.error`。⇒ 依赖「钩子抛错会让调用方拿到 rejected promise」的测试是**假测试**（会报 `Missing expected rejection`）；判定「钩子确实拦下了 bad case」要读 `console.error`（或本仓 `captureError` 式做法）。 | v2 任务 8 控制者实测 |
