# spike：codemode 沙箱可行性（2026-10-15）

**结论：可行。** aiteam 的「沙箱面」可以建在 pi 的 `@earendil-works/pi-codemode` 上。

脚本：`dev/spike/codemode-feasibility.ts`（零 API 成本，不调模型）

## 七项验证结果

| # | 验证 | 结果 | 说明 |
|---|---|---|---|
| 1 | 函数包成 `CodemodeTool` → 脚本 `tools.xxx()` 调到 | ✅ | 只需 `{name, description, inputSchema, execute}` |
| 2 | **脚本里并发** | ✅ | 5 个 agent 并行：90ms（串行应 300ms+） |
| 3 | 脚本内判断/过滤 | ✅ | 「通过代码编排」的核心价值 |
| 4 | 工具抛错能被脚本 `try/catch` 抓到 | ✅ | 错误类型保留 |
| 5 | **隔离属实** | ✅ | 无 `process` / `require` / `fetch` |
| 6 | 超时 | ✅ | `error.kind === "timeout"`，可控 |
| 7 | **调用轨迹可观测** | ✅ | `result.calls[]` 带 `name` / `status` / `durationMs` |

## 关键接口

```ts
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";

const sandbox = new InlineCodemodeSandbox({ tools, wasm, timeoutMs });
const r = await sandbox.execute(scriptSource);
// r = { ok, value, output, calls[], storeWrites, error? }
```

- `InlineCodemodeSandbox`：同线程版（比 worker 版轻，适合设计者编排）
- `execute(code)` 直接返回 `Promise<CodemodeResult>`（**不是** `CodemodeRun`）
- 结果形状：`{ok: boolean, value, output: [], calls: [], storeWrites}`
- 失败时：`{ok: false, error: {kind, message}}`，`kind` 如 `"timeout"`

## 待实现（设计已定）

1. **能力白名单**：设计者声明沙箱里能碰哪些面（与 `permissions` 同构）
2. **当成一个工具**：`agent.tools.add(codemodeTool)`，复用现有机制
3. **限一层**：子 agent 不继承沙箱
