// 探针跑分器：每个探针跑在独立子进程里，一个挂了不影响其余的报告。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const probes = readdirSync(here)
  .filter((f) => /^\d\d-.*\.ts$/.test(f))
  .sort();

const results: Array<{ name: string; status: string; tail: string }> = [];

for (const probe of probes) {
  console.log(`\n${"═".repeat(72)}\n▶ ${probe}\n${"═".repeat(72)}`);
  const run = spawnSync(process.execPath, [join(here, probe)], {
    encoding: "utf8",
    timeout: 180_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  process.stdout.write(output);
  const failed = run.status !== 0;
  results.push({
    name: probe,
    status: failed ? `FAIL(exit ${run.status})` : "OK",
    tail: output.trim().split("\n").slice(-1)[0] ?? "",
  });
}

console.log(`\n${"═".repeat(72)}\n汇总\n${"═".repeat(72)}`);
for (const r of results) {
  console.log(`${r.status.padEnd(16)} ${r.name.padEnd(24)} ${r.tail}`);
}
const bad = results.filter((r) => r.status !== "OK");
console.log(`\n${results.length - bad.length}/${results.length} 个探针通过`);
process.exit(bad.length ? 1 : 0);
