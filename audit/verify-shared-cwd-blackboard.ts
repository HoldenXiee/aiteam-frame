// 探针：共享 cwd 黑板（形态 7）——成员间通过工作目录文件互通。
//
// 重构后架构：**cwd 是实验室的属性，不是成员的**（`AgentSpec` 里没有 cwd 字段，
// 写了会被 createAgent 拒掉）。所以要测「共享 cwd」，正确做法不是给每个成员传同一个
// cwd（那条路已经不存在），而是**开一个 cwd 指向目标目录的实验室**，两个成员从同一个
// 实验室起 —— 实验室本来就是隔离单位，同一个实验室的成员天然共用工作目录。
//
// 这样这个探针证的东西反而更直接：它证的不是「传参传对了」，而是
// 「实验室的 cwd 真的落到了成员的读写工具上」。
//
// 跑法：node audit/verify-shared-cwd-blackboard.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLab } from "../src/index.ts";
import { fauxAgentDir, FAUX_MODEL_REF, tmpCwd } from "../examples/lib/harness.ts";

const workDir = tmpCwd();
const SECRET = "CWD-MARKER-7b2e55";

// 关键：cwd 只在实验室声明一次，两个成员从这里起
const lab = await createLab({ agentDir: fauxAgentDir, cwd: workDir, modelNetwork: false });
const writer = await lab.createAgent({ id: "writer", model: FAUX_MODEL_REF, role: "按指令调用工具。" });
const reader = await lab.createAgent({ id: "reader", model: FAUX_MODEL_REF, role: "按指令调用工具。" });

// writer：脚本约定触发 write 工具，把标记写入 board.md
await writer.io.prompt(`[[tool:write]][[args:{"path":"board.md","content":"${SECRET}"}]]把 ${SECRET} 写入 board.md`);

// reader：脚本约定触发 read 工具，读回 board.md
const readerRun = await reader.io.prompt(`[[tool:read]][[args:{"path":"board.md"}]]读取 board.md 并原样复述内容`);

// 判别：不只看 reader 复述出来，还直接看文件真的落在**实验室声明的那个目录**里
const onDisk = readFileSync(join(workDir, "board.md"), "utf-8");
const ok = (readerRun.text ?? "").includes(SECRET) && onDisk.includes(SECRET);
console.log(ok
  ? `✓ 共享 cwd 生效：writer 写入 ${join(workDir, "board.md")}（落盘 ${onDisk.length} 字节），reader 从同一实验室的工作目录读回`
  : `✗ 共享 cwd 失败：reader 收到 ${JSON.stringify((readerRun.text ?? "").slice(0, 150))} / 落盘=${JSON.stringify(onDisk.slice(0, 120))}`);

writer.dispose();
reader.dispose();
