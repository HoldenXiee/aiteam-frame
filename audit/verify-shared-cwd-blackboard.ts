// 探针：共享 cwd 黑板（形态 7）——成员间通过工作目录文件互通。
// 重构后架构：成员 = 使用者代码创建的 agent（同 cwd），文件读写走内置工具
//（假 provider 用 [[tool:…]] 脚本约定触发）。A 写入 → B 读出 → 内容一致即通过。
// 跑法：node audit/verify-shared-cwd-blackboard.ts
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { makeOfflineAgent } from "../examples/lib/harness.ts";

const workDir = mkdtempSync(join(process.env.TEMP ?? "tmp", "aiteam-cwd-"));
const SECRET = "CWD-MARKER-7b2e55";

const writer = await makeOfflineAgent({ id: "writer", cwd: workDir, role: "按指令调用工具。" });
const reader = await makeOfflineAgent({ id: "reader", cwd: workDir, role: "按指令调用工具。" });

// writer：脚本约定触发 write 工具，把标记写入 board.md
await writer.io.prompt(`[[tool:write]][[args:{"path":"board.md","content":"${SECRET}"}]]把 ${SECRET} 写入 board.md`);

// reader：脚本约定触发 read 工具，读回 board.md
const readerRun = await reader.io.prompt(`[[tool:read]][[args:{"path":"board.md"}]]读取 board.md 并原样复述内容`);

const ok = (readerRun.text ?? "").includes(SECRET);
console.log(ok
  ? `✓ 共享 cwd 生效：writer 写入的 ${SECRET} 被 reader 从同一工作目录读回`
  : `✗ 共享 cwd 失败：reader 收到 ${JSON.stringify((readerRun.text ?? "").slice(0, 150))}`);
