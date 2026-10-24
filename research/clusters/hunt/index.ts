// ★★★ 研究员集群 hunt —— 第一集群（主线）的入口（只管接线，不放规则）
//
// ★★ 2026-10-20 拆分：**这份代码只服务 hunt**。
//   第二集群 forge 的代码在 `research/clusters/forge/`，**互不相干**。
//
// ★ 结构：
//   paths.ts          路径与常量（唯一的路径来源；`CLUSTER` 是**常量** "hunt"）
//   env.ts            实验室环境（凭证 / models.json）
//   guard.ts          写边界守卫（★ 拦的同时给"路" —— P12）
//   prompts/          每个 agent 的提示词一个文件
//   tools/            agent 触发的自定义工具（consult / spawn_line / challenge）
//   topology/rules.ts 代码触发的规则表（情况 → 动作）
//   runner.ts         主流程（起 agent、挂事件、投一次、等窗口）
//   本文件            CLI
//
// 跑法：
//   npx tsx research/clusters/hunt/index.ts --secs=1800
//   npx tsx research/clusters/hunt/index.ts --employees=3   # 多员工（★ 三个角度）
//   npx tsx research/clusters/hunt/index.ts --dry           # 只搭装置不投递
//
//   # ★★★ 做快照给第二集群用（跑之前先做）
//   npx tsx research/clusters/hunt/index.ts --snapshot

import { runCluster } from "./runner.ts";
import { CLUSTER } from "./paths.ts";
import { takeSnapshot, latestSnapshot } from "../snapshot.ts";

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  /research[\\/]clusters[\\/]hunt[\\/]index\.ts$/.test(process.argv[1] ?? "") ||
  process.argv[1]?.endsWith("index.ts")
) {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const secs = Number(arg("secs") ?? 1800);
  const dry = process.argv.includes("--dry");
  // ★★★ 快照（2026-10-19 设计者裁定）：
  //   「把第一集群的成果、研究路径等等内容，在第二集群运行前**复制到第二集群文件夹中**，
  //     让它**在完全独立的环境中运行**。」
  if (process.argv.includes("--snapshot")) {
    const r = takeSnapshot();
    console.log(
      `★ 快照 batch-${String(r.batch).padStart(3, "0")}：${r.files} 个文件 / ` +
        `${(r.bytes / 1024 / 1024).toFixed(1)} MB → forge/${r.dir}`,
    );
    console.log(`  · outbox ${r.freshOutbox} 份（★ 成果）· work/ 研究路径`);
    if (process.argv.includes("--snapshot-only")) process.exit(0);
  }
  // ★★★ 同一身份多员工：起几个研究员（1 = 旧行为；最多 = ANGLES 的个数）
  // ★★★★★ 2026-10-21 · 默认值 **1 → 3**
  //
  //   ★ hunt 的使命是「**广探索** / 冗余 / 创新」。一个角度不叫广探索。
  //   ★★ 实测代价：长期用 `--employees=2` ⇒ 唯一建设性的 `hands-on` 从未起过
  //     ⇒ 80 条提交里 0 条是它，产出全是对抗（证伪 + 审装置）。
  //   ★ 想省钱可以显式传 `--employees=1`，但**默认必须是广的那个**。
  const employees = Number(arg("employees") ?? 3);
  console.log(
    `★ 研究员集群 ${CLUSTER}（触发拓扑）· 窗口 ${secs}s · 研究员 ${employees} 个${dry ? " · 自检" : ""}`,
  );
  await runCluster(secs, dry, employees);
}

export { runCluster };
