# v2 探路发现（S1–S5）

- 日期：2026-10-02
- 性质：**实测**。全部在本机假 provider 上跑，零 API 成本，可复现。
- 对应规格：[`docs/superpowers/specs/2026-10-02-runtime-surfaces-design.md`](../docs/superpowers/specs/2026-10-02-runtime-surfaces-design.md) §7

## 怎么复现

```bash
node spike/s1-tool-reload.ts
node spike/s2-context-hook.ts
node spike/s3-reload-while-running.ts
node spike/s3b-hooks-after-reload.ts
node spike/s4-handler-merge.ts
node spike/s4b-transform-merge.ts
node spike/s5-ctx-shape.ts
```

或一把跑完（脚本只打印结论，失败不设退出码）：

```bash
ls spike/s*.ts | xargs -n1 node
```

---

## 结论汇总

| # | 问题 | 结论 |
|---|---|---|
| S1 | 运行期加工具，模型能看到吗 | **成立**：table + `reload()` 后工具进声明面、能真被执行、也能删掉 |
| S2 | `context` 钩子改的是本轮还是历史 | **一定是「本轮发给模型的」**：逐轮生效、不动历史、原地改也不污染历史 |
| S3 | `reload()` 撞上 running | **pi 不抛错、静默容忍**：7ms 返回 ok，在飞那轮照常跑完 ⇒ 「必须 idle」得**库自己守** |
| S3b | reload 后桥接的钩子还活着吗 | **活着，可反复**：门继续生效、新工具继续可见、连做两次 reload 仍成立；reload 会发 `session_shutdown(reason:"reload")` |
| S4 | 多 handler 谁跑、谁赢 | **按注册顺序链式跑；返回 `block` 短路**（后续 handler 与其他扩展都不再收到）；`undefined` 不覆盖前一个结果 |
| S5 | `{...ctx}` 展开安全吗 | **安全**：ctx 是对象字面量、方法在自有属性且不依赖 `this`。Proxy 不必要 |

---

## S1 运行期加工具（table + reload）

`spike/s1-tool-reload.ts`。桥接扩展在每次 reload 时把内存 `Map` 里的工具重新 `pi.registerTool`。

```
✓ 基线：未加工具时模型看不到 probe_new —— read,bash,edit,write
✓ reload 后 getActiveToolNames() 含新工具 —— read,bash,edit,write,probe_new
✓ reload 后模型真的收到新工具的 schema —— read,bash,edit,write,probe_new
✓ 新工具真的能被执行 —— executed=[probe_new]
✓ remove + reload 后模型看不到它了 —— read,bash,edit,write
```

模型实际收到的声明面轨迹（假服务记录的 `tools`）：

```
#1 tools=[read,bash,edit,write]
#2 tools=[read,bash,edit,write,probe_new]
#3 tools=[read,bash,edit,write,probe_new]   ← 真调用那次
#4 tools=[read,bash,edit,write,probe_new]
#5 tools=[read,bash,edit,write]             ← remove 之后
```

**结论**：规格 §3.4 的常驻桥接扩展 + `reload()` 路线成立。加、用、删三件事都被假服务在 provider 层观测到。

## S2 `context` 钩子语义

`spike/s2-context-hook.ts`。

```
✓ 基线：每轮历史在增长 —— 2 → 4
✓ 返回 {messages: slice(-1)} 生效：发给模型的条数变少 —— growth=4 → cut=2
✓ 历史没被破坏：session.messages 仍在正常增长 —— history 5 → 7
✓ 下一轮恢复完整历史（说明是每轮生效，不是一次性改写） —— cut=2 → back=8
✓ 原地改 event.messages 不会污染 session.messages —— 历史照常增长
✓ 污染测试后历史仍可继续增长 —— 11 → 13
钩子里看到的 messages 长度序列：1,3,5,7,9,11（与 provider count 相差 system 那条）
```

**结论**：`context.override` 的语义就是规格想要的那个——**只改这一轮发给模型的，历史不动**。两个额外事实：

1. pi 传给钩子的是**副本**，原地 `pop()` 不会污染 `session.messages`（比预想的安全）。
2. `context` 钩子拿到的是**不含 system** 的 messages；要连 system 一起改得用 `context_with_system`。

## S3 `reload()` 撞上 running

`spike/s3-reload-while-running.ts`。

```
✓ 此刻确实在 streaming
reload 结果=ok（7ms）
被打断的那轮：跑完了
之后 isStreaming=false
✓ reload 之后会话还能继续用 —— ok
```

**结论**：pi **不抛错**，静默容忍，在飞那轮照常跑完。所以规格里「运行中调用抛错」**不是 pi 的行为，是库要自己加的前置守卫**。这个守卫必须加——否则「加工具的声明面变化」对在飞轮次静默不生效，就是 v1 那类静默失效换了身衣服。

## S3b reload 之后钩子是否还活着

`spike/s3b-hooks-after-reload.ts`。

```
✓ 运行中 reload 期间门被调用过（这轮的工具调用） —— probe_slow
✓ running 中 reload 会发 session_shutdown —— shutdown:reload
✓ reload 之后门仍被调用（桥接没死） —— probe_added
✓ reload 之后新加的工具对模型可见 —— read,bash,edit,write,probe_slow,probe_added
✓ 第二次 reload 后门依然生效（可反复） —— probe_added
生命周期事件：shutdown:reload | shutdown:reload | shutdown:reload
```

**结论**：桥接扩展在 reload 之后**完整复活**，且可反复。规格 §3.4 那条「运行期改动在 reload 后不会丢——它们活在表里，不活在扩展闭包里」被实测证实。

## S4 多 handler：顺序与短路

`spike/s4-handler-merge.ts`。

```
handler 调用顺序：A1 → A2
✓ 同扩展内多个 handler 都会跑 —— A1,A2
✗ A2 返回 block 后，后面的 A3 还跑吗 —— 没跑（短路）
✗ 跨扩展的 B1 跑了吗 —— 被 A2 拦住了
✓ 被拦的工具没有真的执行 —— executed=[]
两个扩展（无拦截）的顺序：C1 → D1
✓ 跨扩展顺序 = 注册顺序 —— C1,D1
```

**结论**：`block` 是**短路**语义——拦下来之后，同扩展的后续 handler 和**其他扩展**的 handler 全都收不到这个事件。这正好是规格想要的「拦下就不再往下走」，而且是 pi 白送的，库不用自己实现；但**必须写进文档**，因为「你被别人的门拦住了、所以什么都不知道」是隐式的。

## S4b 变换类钩子的合并

`spike/s4b-transform-merge.ts`。

```
handler1 看到 3 条，裁到 1 条
handler2 看到 1 条，不返回（不干预）
最终 provider 收到 2 条（system 另算）
✓ handler1 裁剪生效了（发给模型的变少） —— count=2
✓ handler2 仍然被调用（不短路，除非返回 block） —— seenBySecond=1
✓ handler2 看到的是 handler1 之后的消息（链式传递）
```

**结论**：非 `block` 的返回值**链式传递**——后一个 handler 看到的是前一个处理后的结果；返回 `undefined` **不覆盖**前一个的有效结果。

## S5 `AgentContext` 能不能展开

`spike/s5-ctx-shape.ts`。

```
✓ ctx 方法是自有属性（函数本体不丢） —— ownAbort=true
✓ 展开后函数仍存在 —— spread.abort=function
✓ 展开后真能调用（方法不依赖 this）
   spreadIsIdleResult=false / spreadSystemPromptLen=2671 / spreadUsage=有值 / spreadPending=false
✓ Proxy + Reflect.get(receiver) 也能用
```

**结论**：**规格 §7 原设的 Proxy 方案不必要**。pi 的 `ExtensionContext` 是对象字面量，方法（`abort` / `compact` / `isIdle` / `getContextUsage` / `getSystemPrompt` / `hasPendingMessages` / `shutdown` / `isProjectTrusted`）全是自有属性且不依赖 `this`，`{ ...ctx, agent, runId }` 直接可用。这条修正让实现少一层包装。