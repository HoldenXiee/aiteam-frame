# 第 23 部分：结果与聚合（补 08）+ 可复现性与确定性（补 09）

- 真模型：`opencode-go/deepseek-v4.1-flash`，并发 2，每次记录 token 与花费
- 脚本：`e1-json.ts` / `e2-extract.ts` / `e3-soft-hard.ts` / `e3b-conflict.ts` / `e4a-faux-determinism.ts` / `e4b-live-variance.ts` / `e5-sampling.ts` / `e5b-real-sampling.ts` / `e6-thinking.ts` / `e6b-thinking-hard.ts` / `e6c-thinking-wire.ts`
- 原始数据：`data.json`（每次调用的原文、token、耗时、花费都在里面）
- 真实调用 **149 次**（另加 2 次被作废的重跑，见文末花费），全部真模型调用都走 `deepseek-v4.1-flash`

> 说明：`audit/08-aggregation.ts` 的样本是**脚本化的假文本**（不是真模型产出），`docs/.../report §5.2` 的「8/8」是 **4 个模型 × 2 次**、且解析前先剥了代码围栏。本轮把两处都换成单一大样本 + 真模型，并且把「哪些字段错」逐条记下来。

---

## 结论速览

- **E1**：要求「只输出 JSON」+ 扁平三字段 schema → **20/20** 可 `JSON.parse`、**20/20** 字段类型正确、**0** 次带代码围栏、**0** 次夹带前后解说。既有报告的 8/8 成立，样本放大到 20 次仍成立。
- **E2**：逐级难化（中文枚举 / 嵌套 / 对象数组 / 数字 vs 字符串 / 可空 / 300 字长文本）各 5 次，**S2–S7 全部 5/5**。**最先失败的是 S8「深层混合」= 3/5**，两次失败都不是语法错，而是**字段被静默挪位**：模型把 `verdict` 塞进内层 `review` 对象、顶层的 `verdict` 直接消失。`JSON.parse` 照样成功 → 只 parse 不校验字段的实现会把它当成功。
- **E3**：自由散文 + 事后正则。用 `audit/08` 的**原版抽取器**（`"score"` / `"label"` 正则）：两个字段都拿到 **1/10**，10 次里 **0 次**产出 JSON —— 但「至少拿到一个字段」是 **10/10**（散文里的 `3 / 10` 能被命中）。换成**任务感知的自然语言正则**（`方案[A-Z]`、`评分 N 分`）：**10/10**。所以「不强制格式」的代价不是「抽不出来」，而是**「你写的抽取器必须是为这个任务定制的；一换题面就失效」**。
- **E4**：软约束（题目里写「必须只输出 JSON」）10/10、硬约束（唯一可用工具是提交工具）工具被调用 10/10 且参数 10/10 合格。**成功率并列满分，差别在代价**：硬约束墙钟 **9.5s vs 4.4s（2.16×）**、输出 token **均 700 vs 342（2.05×）**、花费 **$0.00525 vs $0.00232（2.26×）**，而且**结构化结果完全不进 `RunResult.text`**（0/10）。
- **E4b**：题目说「只输出 JSON」但环境里挂着提交工具 → 模型 **9/10 照样调了工具**，同时 **10/10 又输出了合格的文本 JSON**。工具的存在本身会改变行为；**两条路都不是"强制"**。
- **E5**：假 provider 下同输入 **10/10** 逐字节一致（sha256 相同），usage 恒为 18，事件序列恒为 `text,turn,done`；`prompt → send` 两轮同样 10/10 一致。既有报告的确定性基线成立。
- **E6**：真模型同输入 10 次：**10/10 文本不同**；字数 66–87（1.32×）；耗时 **2179–5316ms（2.44×）**；**输出 token 45–483（10.7×）**；总 token 3391–3829（1.13×）。→ 单次采样的 token/耗时不能当成本基准，**最噪的是 output**。
- **E7**：`MemberSpec` 没有 temperature/top_p/seed，`createAgentSession` 也不接。但**四条绕法全部实测通到请求体**：① `models.json` 的 `Model.samplingParams`；② `registerProvider` 增/改模型条目；③ **克隆 provider + `streamSimple` 包装注入 temperature**（这条**对真 provider 也跑通了**）；④ `onPayload` 钩子改写原始 payload。另有底座事实：`modelRuntime.completeSimple(model, ctx, { temperature: 0.5 })` 能把 0.5 送进请求体 —— **旋钮在 SDK 上，库没接**。
- **E8**：thinking 档位**在 map 上就失真**：flash 的 `thinkingLevelMap = {low:"low", high:"high", max:"max"}` → `off`/`minimal` 实际是 **low**、`medium` 是 **high**、`xhigh` 是 **max**。**"off" 不是 off**。线上参数 `reasoning_effort` 确实会发（`off` 时整个字段消失）。
- **E9**：两道需要真推理的计数题（正解 66969 / 304598，均经暴力校验），四档×5 + 三档×4 共 **32 次全部答对**。**质量没有拉开**（天花板效应），用量差也淹没在噪声里（同档内 output 极差 10×）。

---

## 实测证据

### E1 大样本：只输出 JSON（S1，20 次）

- **问题**：既有报告的「8/8 可 parse」在 20 次样本上还成立吗？有没有围栏 / 解说文字？
- **方法**：`node audit/23-aggregation/e1-json.ts`。每次新建 agent（无工具、无历史），prompt 固定为「只输出一个 JSON 对象：不要任何解释文字、不要 markdown 代码块」，schema = `{"verdict":"pass"|"fail","reason":"一句话","confidence":0~1 的小数}`。解析前**只去掉首尾围栏**，并同时记录「原样 parse 是否成功」。
- **原始输出**（20 行摘录）：
  ```
  # 1 parse-ok fence=false prose=false 字段错=0 3094ms 52tok
  # 7 ...  #12 parse-ok fence=false prose=false 字段错=0 2059ms 65tok
  #20 parse-ok fence=false prose=false 字段错=0 2775ms 94tok
  汇总：S1-baseline: parseOk 20/20　字段全对 20/20　围栏 0　夹解说 0　类型错 0　均 69out/2800ms
  ```
- **读出的现象**：20 次全部原样就是 JSON（`rawParseOk` 也是 20/20，剥围栏这个动作一次都没用上）。没有一次出现代码围栏或前后解说。输出长度 45–115 token。
- **结论**：**能**。扁平、字段少的 schema + 明确要求 + 单轮无历史时，这是一个可以指望的通道（20/20）。既有报告的 8/8 得到复现与加强。

### E2 难化：S2–S8 各 5 次 —— 最先失败的是「深层混合」

- **问题**：schema 复杂到什么程度开始坏？坏成什么样？
- **方法**：`e1-json.ts` 后半段，同一批脚本化 prompt，逐级加难度（中文枚举 → 嵌套 → 对象数组 → 类型压力 → 可空 → 300 字长文本 → 深层混合），每级 5 次。
- **原始输出**：
  ```
  S2-中文枚举: 完全合格 5/5
  S3-嵌套对象: 完全合格 5/5
  S4-对象数组: 完全合格 5/5
  S5-类型压力: 完全合格 5/5
  S6-可空字段: 完全合格 5/5
  S7-长文本值: 完全合格 5/5　（均 970 输出 token / 8.3s）
  S8-深层混合: 完全合格 3/5　ok ok [verdict=undefined] ok [verdict=undefined]
  ```
  S8 的两次失败原文（截取）：
  ```json
  {"review":{"id":"R1", ... ,"issues":[...],"verdict":"approve"},"notes":"..."}
  ```
- **读出的现象**：两次失败**语法完全合法**（`JSON.parse` 成功），错的是**形状**：模型把 `verdict` 放在了内层 `review` 里，顶层没有这个键。`S7` 要求「不少于 300 汉字」也 5/5 通过，代价是输出 token 从 69 涨到 970、耗时涨到 8.3s（≈3× 基线）。所有 5 次失败/成功里，**代码围栏 0 次、前后解说 0 次**。
- **结论**：**部分能**。真正的失败模式不是「JSON 坏了」，而是**「字段被静默挪位或省略」**。边界：**同一层里字段越多、嵌套越深，越容易缺字段**（S8 = 4 个顶层键 + 2 层嵌套，开始掉点）。只做 `JSON.parse` 不校验字段的消费者会**静默**接受一个错的形状。

### E3 自由散文 + 事后正则（N=10）

- **问题**：复测既有报告的「2/5 成功、3 个被静默丢弃」——在真模型上是什么数字？
- **方法**：`node audit/23-aggregation/e2-extract.ts`。prompt 里**不提任何格式要求**（「给出你的评分（0 到 10 分）和你的推荐结论（方案A / 方案B）」），然后用 `audit/08-aggregation.ts` 里**原封不动的抽取器**（`scoreOf` / `vote` / `extractJson`）与一个更宽松的散文抽取器各跑一遍。
- **原始输出**：
  ```
  # 2 19861ms 3053tok　旧抽取 score=4 label=undefined　宽松抽取 score=4 label=方案B
  # 8 22106ms 2875tok　旧抽取 score=6 label=undefined　宽松抽取 score=6 label=方案A
  旧抽取器：两个字段都拿到 1/10；至少拿到一个 10/10；带 JSON 的 0/10
  宽松抽取器：两个字段都拿到 10/10；至少拿到一个 10/10
  ```
  单条原文（散文形态，`评分：**3 / 10**`、`推荐结论：**方案 B（改为并发 + 重试）**`）。
- **读出的现象**：真模型在「不强制格式」时**一次 JSON 都不写**（0/10），而是写 1907–6429 token 的 markdown 长文（这个臂 10 次共 $0.02105，单次均 $0.0021 = JSON 臂单次 $0.000156 的约 13 倍）。旧抽取器靠 `(\d+)\s*\/\s*10` 侥幸拿到分数（10/10），但 `"label"` 正则只命中 **1/10**。把标签换成 `方案[A-Z]`、分数加一条 `评分[^\d]{0,6}(\d+)`，就 **10/10**。
- **结论**：**部分能**，但结论要说得比既有报告更准确：**「2/5」不是「抽不出来」，是「用为 JSON 写的正则去抽散文」**。真正的代价是 **① 输出 token 涨 2–3 倍（免费文本 = 付费文本）② 抽取器必须逐题定制，题面一换就失效 ③ 静默丢**（拿不到就是 `undefined`，没有报错）。

### E4 软约束 vs 硬约束（每臂 10 次）

- **问题**：题目里写「必须只输出 JSON」（软）和「唯一可用工具是提交工具」（硬），成功率差多少？代价差多少？
- **方法**：`node audit/23-aggregation/e3-soft-hard.ts`。三臂同题同 schema（`findings` 恰好 3 条）：
  - A `参数里写死格式`：无工具，prompt 要求只输出 JSON；
  - B `硬`：`tools:["submit_review"]` + customTool（typebox schema），prompt 说「你必须调用 submit_review，不调用就等于没回答」；
  - C `半硬`：同一工具，prompt 只说「请把结果通过 submit_review 工具提交」。
  工具 `execute` 里用闭包收参数（`paramsValid` = 参数过了 typebox 校验且语义（恰好 3 条）也合格）。
- **原始输出**：
  ```
  A-软约束: 工具被调用 0/10　文本 JSON 合格 10/10　均 4411ms
  B-硬约束: 工具被调用 10/10　参数合格 10/10　文本 JSON 合格 0/10　均 9513ms
  C-半硬:   工具被调用 10/10　参数合格 10/10　文本 JSON 合格 0/10　均 9409ms
  ```
- **读出的现象**：**成功率三臂并列满分**。差别全在代价上：硬/半硬臂墙钟 2.16×，输出 token 均 700（B）/ 976（C）vs 342（A），花费 $0.00525（B）/ $0.00693（C）vs $0.00232（A）。另外 B/C 臂的 `RunResult.text` 里**再也没有结构化结果**（0/10 合格）—— 结果只在工具 `execute` 的闭包里，设计者必须自己把它和 agentId 一起捞出来（既有报告 8.2b 的结论）。
- **结论**：**两条路都可用，且都不"强制"**。软约束在中等复杂度 schema 上 10/10，代价最低；硬约束换来的是**类型必然正确**（typebox 在 execute 之前校验）和**失败可检测**（不调用工具就是 0 次提交，可以事后对账），代价是 2× 时间与 2.5× token，以及「结果不在 RunResult 里」。注意 **B 与 C 没有差别**（10/10 vs 10/10）——「必须」这个词并不比「请」更有效。

### E4b 契约冲突：说「只输出 JSON」，但挂着提交工具（N=10）

- **问题**：题面与环境给出两套不一致的契约时，模型走哪条？
- **方法**：`node audit/23-aggregation/e3b-conflict.ts`。prompt 与 A 臂逐字相同（**只字不提工具**），但 `tools:["submit_review"]`。
- **原始输出**：
  ```
  # 8 3844ms 467tok　工具调用 0 次（合格 0）　文本 JSON 合格=true
  #10 9387ms 877tok　工具调用 1 次（合格 1）　文本 JSON 合格=true
  # 5 118165ms 658tok　工具调用 1 次（合格 1）　文本 JSON 合格=true
  走工具 9/10　走文本 10/10　两边都合格 9　两边都不合格 0
  ```
- **读出的现象**：**模型在没有任何指示的情况下，9/10 主动调用了工具**，并且 **10/10 同时给出合格的文本 JSON**。注意 `#5` 单次耗时 **118 秒**（同批其他 3.8–17 秒）—— 工具存在会让这一轮的墙钟变得不可预测。
- **结论**：**能，但不是好事**。挂上提交工具＝改变了行为（没有指示也会调），而两条通道同时可用时，两边的结果**不保证一致**（本批 9 次两边都有，1 次只有文本）。阶段 2 必须规定「以哪条为准」，否则会拿到两份可能互相矛盾的结论。

### E5 假 provider 的确定性基线（10 次）

- **问题**：把假 provider 当确定性回归基线，10 次够稳吗？
- **方法**：`node audit/23-aggregation/e4a-faux-determinism.ts`。同输入 10 次（每次新建 agent）；另一组 10 次跑 `prompt → send` 两轮。比对**文本 sha256**、usage、事件序列。
- **原始输出**：
  ```
  text 去重 1/10　sha 去重 1/10　usage 去重 1/10（18）　事件去重 1/10（text,turn,done）
  第 1 轮 sha 去重 1/10　第 2 轮 sha 去重 1/10　事件序列去重 1/10
  判定：逐字节确定（单轮 + 两轮）
  ```
- **读出的现象**：10/10 逐字节一致，包括两轮会话。
- **结论**：**能**。假 provider 是可靠的确定性基线，机制层回归测试可以用它做精确断言（既有报告 §6 成立，样本从 5 提到 10）。

### E6 真模型方差（同输入 10 次）

- **问题**：同输入 10 次，文本/token/耗时抖动多大？
- **方法**：`node audit/23-aggregation/e4b-live-variance.ts`。prompt 固定（解释「幂等」，≤80 汉字），每次新建 agent（无历史）。
- **原始输出**：
  ```
  # 2 4257ms out=77  total=3423    # 1 5316ms out=455 total=3801
  # 4 2524ms out=72  total=3418    #10 4035ms out=483 total=3829
  文本去重 10/10　字数 66-87（中位 81）
  耗时 2179-5316ms（中位 3789.5，极差 3137ms = 2.44×）
  输出 token 45-483（中位 102.5，极差 438）　总 token 3391-3829（极差 438 = 1.13×）
  ```
- **读出的现象**：**10 次文本全不相同**（措辞级差异，长度 66–87 字）。输出 token 呈双峰：45–128 与 455–483 两簇（×10 倍），且高 output 的那几次耗时也在 4–5.3s。总 token 只有 1.13× 抖动是因为 `cacheRead` 恒定占大头（3200–3328）。单次花费 3.97e-5 ~ 3.05e-4 美元（7.7×）。
- **结论**：**产出不可复现**（10/10 不同），**但口径不同**：字数只抖 1.32×、总 token 1.13×、**输出 token 10.7×**、耗时 2.44×。阶段 2 若按「输出长度」或「单次耗时」估成本会大错；按「总 token」估则相对稳。

### E7 采样参数：库没有旋钮，四条绕法全部实测

- **问题**：`MemberSpec` 没有 temperature/top_p/seed —— 有没有办法给**同一个模型的两个成员**配出不同温度？
- **方法**：`node audit/23-aggregation/e5-sampling.ts`：本机假服务**记录原始请求体**（零真实花费），逐条验证绕法；再用 `e5b-real-sampling.ts` 把第 ③ 条对**真 provider** 跑一遍（本机 HTTPS 转发代理，记录发出的 body）。
- **原始输出**：
  ```
  绕法1 models.json 的 Model.samplingParams：
    samp/base : {"model":"base"}
    samp/cold : {"model":"cold","temperature":0.1,"top_p":0.1,"seed":7,"top_k":5,"repetition_penalty":1.1}
  绕法2 registerProvider 注册新模型条目：
    samp/warm : {"model":"warm","temperature":0.77}
  绕法3 克隆 provider + streamSimple 包装注入：
    inject/twin : {"model":"twin","temperature":0.99}
  绕法4 onPayload 钩子改写原始 payload：
    payload/twin : {"model":"twin","temperature":0.33,"seed":42}
  底座：runtime.completeSimple(model, ctx, {temperature:0.5, samplingParams:{top_k:5}})
    → 请求体 {"model":"plain","temperature":0.5,"top_k":5}
  真 provider（opencode.ai/zen/go）：
    og-cold: 代理看到的请求体 temperature=0.05 model=deepseek-v4.1-flash　回复="好"
    og-hot : 代理看到的请求体 temperature=0.95 model=deepseek-v4.1-flash　回复="好"
  ```
- **读出的现象**：
  - ① `models.json` 的 `samplingParams` 是**按模型条目**的，且**条目 id 就是发给 provider 的 model 名** —— 所以给真实模型复制两个只差温度的条目**不可行**（会发出两个对方不认识的 model 名）。任意键都原样透传（`top_k`/`repetition_penalty` 也在）。
  - ② `registerProvider(providerId, config)` 能往已有 provider 里加/改模型条目（本机实测覆盖后旧条目消失）。
  - ③ **可行解**：注册两个**新的 provider id**（`og-cold`/`og-hot`）指向同一个 baseUrl，各自 `streamSimple` 包一层 `{...options, temperature}`，模型条目 id 保持 `deepseek-v4.1-flash` —— **真 provider 接受，两个成员各自拿到 0.05 / 0.95**。代价两条：**(a)** 克隆 provider 会掉 opencode 的会话归属头（built-in 只在 `provider==="opencode-go"` 或 host 是 `opencode.ai` 时补），必须自己加 `x-opencode-session` / `x-opencode-client`，否则真 API 直接 `400 MissingSessionID`；**(b)** 自建模型条目的 `cost` 表默认是 0，**用量记账会变成 $0**（要么照抄真实价格，要么接受成本盲区）。
  - ④ `onPayload` 在适配器层面改请求体，也通。
  - **另有一处可直接用的口子**：`runtime.completeSimple(model, ctx, {temperature})` 能把参数送进请求体 —— 也就是说**旋钮在 SDK 上，只是库的 `createAgent`/`createAgentSession` 从不传 `SimpleStreamOptions`**。另外 `model.samplingParams` 会**覆盖**同名逐请求字段（实测：模型条目写 0.77 时，逐请求传的 0.5 被吃掉）。
- **结论**：**能做到**，但没有任何一条是「按成员配置」的一等公民：**最省事的做法是绕法③（克隆 provider + `streamSimple`），代价是自补归属头 + 成本表。** 库侧是一个纯缺口（`MemberSpec` 无字段、`createAgentSessionOptions` 不接 `SimpleStreamOptions`），修复成本看起来只是把字段透传下去。`seed` 同理：库没有，但绕法①③④都能注入。

### E8 thinking 档位：先看请求体，再看效果

- **问题**：`thinking` 四档到底改了什么？
- **方法**：`node audit/23-aggregation/e6c-thinking-wire.ts`（假服务记录请求体），加 `e0b-levels.ts`（对真模型读 `session.thinkingLevel`）。
- **原始输出**：
  ```
  th/can-think 请求=off     → 实际=off     {"model":"can-think",...,"max_completion_tokens":8192}
  th/can-think 请求=minimal → 实际=minimal {...,"reasoning_effort":"minimal"}
  请求=high → 实际=high {"reasoning_effort":"high"}
  请求=xhigh→ 实际=high  请求=max → 实际=high      ← 被夹到 high
  th/cannot（reasoning:false）7 档全部 → 实际=off，请求体里没有 reasoning_effort
  ```
  真模型 `deepseek-v4.1-flash`：`thinkingLevelMap={"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"}`
  ```
  off → session: low      minimal → low     medium → high     xhigh → max
  ```
- **读出的现象**：档位**确实翻译成了线上参数** `reasoning_effort`（`off` 时该字段整个消失，而不是传 `"off"`）。但**请求→生效是失真的**：在这条模型上 `off`/`minimal` 实际都是 `low`（**"off" 不是 off**），`medium` 实际是 `high`，`xhigh` 是 `max`；`reasoning:false` 的模型 7 档全归 `off`。
- **结论**：**部分能**。`thinking` 不是「关思考」的开关，而是「在模型支持的档位里挑最近的」。既有报告「四档在用量上无区别」有一半解释在这里：他们比的 `off` 与 `low` **本来就是同一档**。

### E9 thinking 对真实生成质量的影响（两道难题，32 次）

- **问题**：既有报告说「题目太简单，拉不开质量差」。换难题能不能拉开？
- **方法**：
  - P1 = `1..1000000` 中「十进制里 7 恰好出现两次且不含 0」的整数个数 → 正解 **66969**；
  - P2 = `1..1000000` 中「7 出现次数严格多于 3 出现次数」的整数个数 → 正解 **304598**；
  - 两个正解都由脚本内暴力枚举校验（跑不过就 throw）；评分取出模型最后一行数字。
  - P1：档位 `off/low/high/max`（实际 low/low/high/max）× 5；P2：`low/high/max` × 4。
- **原始输出**：
  ```
  P1  请求 off →实际 low ：正确 5/5  答案 [66969×5]  输出 633-927（均 810）均 6671ms
      请求 low →实际 low ：正确 5/5  答案 [66969×5]  输出 367-1120（均 656）均 6551ms
      请求 high→实际 high：正确 5/5  答案 [66969×5]  输出 727-862（均 785） 均 7184ms
      请求 max →实际 max ：正确 5/5  答案 [66969×5]  输出 749-1343（均 961）均 10945ms
  P2  low ：正确 4/4  均 1393（最大 1976）tok  均 15070ms
      high：正确 4/4  均 1373（最大 1665）tok  均 13963ms
      max ：正确 4/4  均 1525（最大 1697）tok  均 13088ms
  ```
- **读出的现象**：**32/32 全对**。P1 里 `max` 输出偏多（961 vs 656/785）、耗时偏高，但 P1 同档内极差就有 367–1343（3.7×）；P2 里三档几乎一样，`max` 甚至平均更快。对照 E6（同输入 output 45–483，10.7×），**这些差异无法与噪声分离**。
- **结论**：**测不出**。在这条模型上，thinking 档位对「这类计数推理题」的正确率没有可测影响（**天花板效应**：选哪档都全对），用量差异也淹没在噪声里。**没有反面证据说档位无效**，只能说：**用「质量」或「用量」去验证档位生效，这条模型 + 这类题目做不到**。想验证只能看线上参数（E8 已证 `reasoning_effort` 确实发出去了）。

---

## 面向阶段 2 的建议（怎么拿结构化结果才可靠）

按可靠度从高到低，四个选项，都有实测依据：

1. **要「类型必然正确」→ 用工具提交（硬通道）。**
   实测 10/10 调用、10/10 参数类型正确（E4）。做法：`customTools` 里放一个 `submit_result`，参数用 typebox 写死，白名单只留它（`tools: ["submit_result"]`，注意 `tools: []` 会**一个工具都不给**，customTools 也就进不来）。**必须自己加三件事**：① 收集闭包（结果不进 `RunResult.text`，E4）；② 「没提交」的对账（不提交不报错，既有报告 8.2d）；③ 别在同一轮里同时允许"文本 JSON"与"工具提交"两条路（E4b：两套契约会同时被满足，且可能不一致）。

2. **要「便宜且够用」→ 软约束 + 强制校验，不强制传输。**
   扁平/中等 schema 实测 20/20 + 15/15（E1/E2）。代价最低（69–342 输出 token）。**但必须写字段校验**，不能只 `JSON.parse`：E2 的 S8 就是 parse 成功、字段缺失（3/5）。校验失败→重试一次是最便宜的兜底。

3. **schema 越平越好。** 证据：E2 里嵌套 2 层的 S8 最先掉点（3/5），两层以上的结构出现「字段被挪进内层」；S3/S4（一层嵌套、数组）都还 5/5。建议：**顶层扁平 + 枚举用英文小写常量 + 数字字段不要和字符串字段挨着**（S5 类型压力 5/5，说明单靠"数字 vs 字符串"本身不会坏，坏的是层级深度）。

4. **不要依赖「事后正则从散文里抠」**（除非接受每道题写一套正则）。实测：原版 JSON 正则 1/10；任务定制正则 10/10，但换题就失效；而且散文臂输出 1907–6429 token，**单次花费是 JSON 臂的约 13 倍**（$0.0021 vs $0.000156，E3）。

配套的三条工程约束：

5. **预算估算用「总 token」，不要用「输出长度」或「单次耗时」。** 同一输入 10 次：输出 token 10.7× 抖动、耗时 2.44×、总 token 1.13×（E6）。按 output 估会错一个数量级（E3 的散文臂就是被这样打爆的：10 次 $0.021，比 55 次 JSON 调用还贵）。

6. **不要用 `thinking` 档位做质量/成本开关。** ① 在 flash 上 `off` 实际是 `low`（E8），写了 `off` 也没有「省脑力」这回事；② 档位对正确率无可测影响（E9）。它在设计上最适合表达「这条成员我允许它慢一点」，而不是「这条成员便宜」。

7. **要按成员配温度/seed，只有绕法③（克隆 provider + `streamSimple`）可用。** 代价明确：自补 `x-opencode-session` / `x-opencode-client` 头（否则真 API 400），模型条目的 `cost` 表要自己照抄（否则用量记账变 $0）。库侧若能透传 `SimpleStreamOptions`（`temperature` / `samplingParams`）就是一行级修复 —— `MemberSpec` 只需加 `temperature?: number`、`samplingParams?: Record<string, unknown>`，在 `create-agent.ts` 里转成 session 的 stream 选项。**在那之前，"发散成员 vs 保守成员"这个非常自然的团队设计需求是做不到的。**

---

## 清单

| # | 现象 | 类别 | 严重度 | 证据 |
|---|---|---|---|---|
| 1 | 「只输出 JSON」在 20 次样本上 20/20 可 parse、字段全对，0 围栏 0 解说 | 能力 | — | E1 |
| 2 | 深层混合 schema 最先失败（3/5），失败形态是**字段被挪进内层/顶层键缺失**，`JSON.parse` 仍成功 | **静默失败** | 高 | E2 |
| 3 | 只 parse 不校验字段的消费者会静默接受错形状 | **静默失败** | 高 | E2 |
| 4 | 自由散文下真模型 0/10 写 JSON；为 JSON 写的正则两个字段只拿到 1/10 | 极限 | 中 | E3 |
| 5 | 任务感知正则能把散文抽取做到 10/10，但每换题面就要重写 | 缺口 | 中 | E3 |
| 6 | 散文臂输出 1907–6429 token，单次花费 $0.0021（JSON 臂 $0.000156，**约 13 倍**）；10 次的总额比 55 次 JSON 调用还贵 2.4 倍 | 能力/极限 | 中 | E3 |
| 7 | 软约束与硬约束成功率并列 10/10；硬约束贵 2.16× 时间 / 2.05× 输出 token / 2.26× 花费 | 能力 | — | E4 |
| 8 | 硬约束下结构化结果**完全不进 `RunResult.text`**，只在工具闭包里 | 缺口 | 中 | E4 |
| 9 | 「必须调用工具」并不比「请调用工具」更有效（10/10 vs 10/10） | 极限 | 中 | E4 |
| 10 | 同时存在「文本 JSON 契约」与「提交工具」时，模型 9/10 走工具、10/10 又给文本，两边可能不一致 | **静默失败** | 高 | E4b |
| 11 | 挂上提交工具后，单次耗时出现 118s 的离群（同批 3.8–17s） | 极限 | 低 | E4b |
| 12 | 假 provider 10/10 逐字节确定（含两轮） | 能力 | — | E5 |
| 13 | 真模型同输入 10/10 文本不同；输出 token 45–483（10.7×）、耗时 2.44×、总 token 1.13× | 极限 | 高 | E6 |
| 14 | `MemberSpec`/session 无 temperature/top_p/seed；SDK 层 `completeSimple` 有 | 缺口 | 高 | E7 |
| 15 | 绕法①`models.json.samplingParams` 按**模型条目**生效，条目 id = 线上 model 名，故无法给真模型复制两份 | 极限 | 中 | E7 |
| 16 | 绕法③克隆 provider + `streamSimple` 对**真 provider** 跑通（0.05/0.95 均返回正常） | 能力 | — | E7 |
| 17 | 克隆 provider 会掉 `x-opencode-session` 归属头 → 真 API 400 | 极限 | 中 | E7 |
| 18 | 自建模型条目的 cost 表默认 0 → 用量记账变 \$0 | **静默失败** | 中 | E7 |
| 19 | `model.samplingParams` 会覆盖逐请求的 `temperature`（0.5 被 0.77 吃掉） | 静默行为 | 低 | E7 |
| 20 | `off` 在 flash 上实际落到 `low`；`medium`→`high`、`xhigh`→`max`（档位失真） | **静默失败** | 中 | E8 |
| 21 | `reasoning_effort` 确实发到线上；`off` 时该字段整个消失 | 能力 | — | E8 |
| 22 | `reasoning:false` 的模型 7 档全归 `off`（既有报告 1.1n 复现） | 极限 | 低 | E8 |
| 23 | 两道需真推理的计数题（66969 / 304598）32/32 全对，四档正确率无差 | 极限（天花板） | 中 | E9 |
| 24 | thinking 档位的用量差异（均 961 vs 656，P1）小于同档内抖动（367–1343），不可分离 | 极限 | 中 | E9 |

---

## 花费与未完成

**真实花费**：`data.json` 记录的 149 次调用合计 **$0.0746 / 806,882 token**；加上两次被作废的重跑（`e1` 小样本 $0.00453、`e3` 首版 prompt 漏写字段要求 $0.01594）与冒烟，**实际约 $0.095（≈¥0.7）**。
（`e5b` 的 2 次真调用在记账上显示 $0 —— 克隆出来的模型条目 cost 表是 0，这本身就是编号 18 的证据。）

**未完成 / 没测到的**：
- E9 的**质量**问题只得到「天花板」答案：该模型在这两道题上哪档都对。要真正测出档位对质量的收益，需要一道**它做不到**的题（本轮没找到），或者换成弱模型（超出「只用 flash」的约束）。
- 没有测 `RunResult` 串台（基线 K）与本轮结构化实验结果的关系 —— 即「工具提交路在 K 的串台场景下会不会把结果算到别人头上」。
- 没有测 **schema 校验失败后的自动重试**是否真能补回成功率（只测了单次成功率），也没有测多轮对话（带历史）下 S8 的缺失率是否更高。
- `samplingParams` 的温度差异是否真的改变模型行为（只验证了参数到线上，没有做「0.05 vs 0.95 的输出分布对比」）。
