// ★ 跑一次：三份 lib 的漂移（★ 零模型成本，纯读盘）
//
//   npx tsx research/clusters/micro/libdrift.ts
//
// ★ 纪律㉙：这个读具自己也要能被证明是活的 ——
//   认不出来的 diff 行必须让它 exit 1，不能静默当"没有差异"。
import { execSync } from "node:child_process";
import { parseDrift, renderDrift } from "../libdrift.ts";

// ★★★ 根必须对齐：`src/` 的布局是 `agent/ index.ts surfaces/`，
//   而 `hunt/lib/` 下面还有一层 `aiteam/`。
//   ★ 第一次我拿 `hunt/lib` 直接比 `src` ⇒ 读具报「只在左 aiteam / 只在右 agent」,
//     那是**根没对齐**，不是真漂移。（读具没骗我，是我差点读错。）
const pairs: [string, string][] = [
  ["research/labfirst/hunt/lib/aiteam", "src"],
  ["research/labfirst/forge/lib/aiteam", "src"],
  ["research/labfirst/hunt/lib/aiteam", "research/labfirst/forge/lib/aiteam"],
];

let bad = 0;
for (const [a, b] of pairs) {
  let out = "";
  try {
    out = execSync(`diff -rq "${a}" "${b}" 2>&1 || true`, { encoding: "utf8", maxBuffer: 1e8 });
  } catch (e) {
    out = String(e);
  }
  const { drift, ignore } = parseDrift(out.split("\n"), a, b);
  console.log(renderDrift(drift));
  if (ignore.length) {
    bad++;
    console.log(`   ⛔ ${ignore.length} 行 diff 输出认不出来（前 3 行）：`);
    ignore.slice(0, 3).forEach((x) => console.log(`      ${x}`));
  }
  console.log("");
}
if (bad) {
  console.log(`⛔ 有 ${bad} 组输出没认全 —— 这个读具本身可能没接上`);
  process.exitCode = 1;
}
