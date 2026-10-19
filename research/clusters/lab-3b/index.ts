// ★★★ 研究员集群 lab-3b —— 入口（只管接线，不放规则）
//
// ★ 结构（2026-10-18 拆分）：
//   paths.ts          路径与常量（唯一的路径来源；`CLUSTER` 环境变量切集群）
//                      ★★ 同一份代码跑两个集群：
//                        · `CLUSTER=lab-3b`（默认）= 第一集群：广探索/冗余/创新
//                        · `CLUSTER=lab-2`        = 第二集群：体系化/检验/归纳批判
//                      差别在 `prompts/missions.ts`（使命）+ 各自的 `inbox/研究手册.md`
//   env.ts            实验室环境（凭证 / models.json）
//   guard.ts          写边界守卫（★ 拦的同时给"路" —— P12）
//   prompts/          每个 agent 的提示词一个文件（★ 本文件的重点：一眼看清谁在说什么）
//   tools/            agent 触发的自定义工具（consult / spawn_line）
//   topology/rules.ts 代码触发的规则表（情况 → 动作）
//   runner.ts         主流程（起 agent、挂事件、投一次、等窗口）
//   本文件            CLI
//
// 跑法：
//   npx tsx research/clusters/lab-3b/index.ts --secs=1800
//   npx tsx research/clusters/lab-3b/index.ts --employees=3   # ★★★ 同一身份多员工
//   npx tsx research/clusters/lab-3b/index.ts --dry          # 只搭装置不投递（自检）
//   ★★★ 第二集群（体系化）：
//   CLUSTER=lab-2 npx tsx research/clusters/lab-3b/index.ts --secs=3600

import { runCluster } from "./runner.ts";
import { CLUSTER } from "./paths.ts";

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  /research[\\/]clusters[\\/]lab-3b[\\/]index\.ts$/.test(process.argv[1] ?? "") ||
  process.argv[1]?.endsWith("index.ts")
) {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const secs = Number(arg("secs") ?? 1800);
  const dry = process.argv.includes("--dry");
  // ★★★ 同一身份多员工：起几个研究员（1 = 旧行为；最多 = ANGLES 的个数）
  const employees = Number(arg("employees") ?? 1);
  console.log(
    `★ 研究员集群 ${CLUSTER}（触发拓扑）· 窗口 ${secs}s · 研究员 ${employees} 个${dry ? " · 自检" : ""}`,
  );
  await runCluster(secs, dry, employees);
}

export { runCluster };
