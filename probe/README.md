# 探针（一次性）

验证规格里最可能被推翻的 SDK 假设。**这些是探路代码，不是产品代码**，但
`_support.ts` 的假 LLM 服务是规格第 7 节「零成本测试策略」的地基，实现阶段会搬进 `test/`。

跑法：`npm run probe`（零 API 花费，7 个探针共约 60 条断言）

| 探针 | 验什么 |
|---|---|
| `01-fake-provider.ts` | 假 provider 能否跑通完整 prompt、usage 能否读、多轮与空闲状态 |
| `02-multi-agent.ts` | 同进程多 agent、共享 ModelRuntime、真并发、上下文与 cwd 互不串 |
| `03-busy.ts` | 忙时 prompt/steer/followUp 语义（决策 #18/#19 的实证） |
| `04-tools.ts` | 工具白名单与 customTools 的关系、execute 签名、tool_call 审批门 |
| `05-loader.ts` | project trust 真相、技能注入、systemPrompt 三个旋钮的区别 |
| `06-model.ts` | resolveCliModel / 作用域解析 |
| `07-events.ts` | 原始事件形状，归一化映射是否够用 |

结论见 `docs/specs/` 里的规格修订记录。
