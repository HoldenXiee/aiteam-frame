// ★★★ 研究员集群 forge —— 第二集群（阶段性沉淀）的入口（只管接线，不放规则）
//
// ★★ 2026-10-20 拆分：**这份代码只服务 forge**。
//   第一集群 hunt 的代码在 `research/clusters/hunt/`，**互不相干**。
//   ★ 设计者裁定：「forge 单独是要单独设计的」—— 拆分就是为了让它能单独改。
//
// ★ 结构：
//   paths.ts          路径与常量（唯一的路径来源；`CLUSTER` 是**常量** "forge"）
//   env.ts            实验室环境（凭证 / models.json）
//   guard.ts          写边界守卫（★ 拦的同时给"路" —— P12；★ hunt 空间只读）
//   prompts/lines.ts  三队 × 四观众的定义（★ forge 独有的形状）
//   prompts/          每个专家 agent 的提示词 + 使命
//   tools/            consult / spawn_line / challenge / sign_off / joint_experiment / judge / publish
//   topology/rules.ts 代码触发的规则表（七条：审查/缺口/平台期/辩证/观众/共识/僵局）
//   runner.ts         主流程（起 6 席 + 4 观众、挂规则、等窗口）
//   本文件            CLI
//
// 跑法（★ 不再需要 CLUSTER 环境变量 —— 路径就说明了一切）：
//   npx tsx research/clusters/forge/index.ts --dry --employees=2        # 自检，零成本
//   npx tsx research/clusters/forge/index.ts --secs=7200 --employees=2
//   npx tsx research/clusters/forge/index.ts --snapshot --secs=7200 --employees=2

import { runCluster } from "./runner.ts";
import { CLUSTER } from "./paths.ts";
import { takeSnapshot, latestSnapshot } from "../snapshot.ts";

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  /research[\\/]clusters[\\/]forge[\\/]index\.ts$/.test(process.argv[1] ?? "") ||
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
  const employees = Number(arg("employees") ?? 1);
  console.log(
    `★ 研究员集群 ${CLUSTER}（触发拓扑）· 窗口 ${secs}s · 研究员 ${employees} 个${dry ? " · 自检" : ""}`,
  );
  await runCluster(secs, dry, employees);
}

export { runCluster };
