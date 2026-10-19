// ★★★ 两个集群的边界：第二集群能**读**第一集群，但**不能写**它。
//
// ★ 为什么这值得一条测试（2026-10-19 实测发现的洞）：
//   守卫原来只知道**自己的** `LAB` ⇒ 第二集群分析第一集群时，
//   `write lab-3b/outbox/P44.md` 会被**放行** —— 而那是它正在分析的对象。
//   ★★ 改掉被分析的对象 = **结论建在自己改过的证据上，且无声无息**。
//
// ★ 这是本项目反复吃过的同一类坑（`P17`：一个能力多个入口）：
//   「只读」不能只在"不是我的目录"上生效 ——
//   有一类目录"是别人的、但特别需要只读"（**被分析对象**）。
//
// ★ 测法：直接用**纯函数**（把三个目录当参数）。不靠子进程 —— 那样要赌
//   环境变量、npx 缓存路径、Ctrl 字符，测的是装置不是逻辑。

import { test } from "node:test";
import assert from "node:assert/strict";
import { outsideWrite, type Bounds } from "../../research/clusters/lab-3b/guard.ts";

const SRC = "D:/repo/research/labfirst/lab-3b";
const OWN = "D:/repo/research/labfirst/lab-2";

/** 第二集群看到的边界 */
const AS_LAB2: Bounds = { lab: OWN, sourceLab: SRC, isSource: false };
/** 第一集群看到的边界（它就是源头，没有"别人的空间"） */
const AS_LAB3B: Bounds = { lab: SRC, sourceLab: SRC, isSource: true };

test("★★★ 第二集群：读第一集群放行，写第一集群拦住", () => {
  // 读 —— 那是它的原料，必须全通
  assert.equal(
    outsideWrite("read", { path: `${SRC}/outbox/P44.md` }, AS_LAB2),
    null,
    "★ 读第一集群的结论必须放行",
  );
  assert.equal(
    outsideWrite("bash", { command: `cat ${SRC}/work/x.jsonl` }, AS_LAB2),
    null,
    "★ 读原始数据必须放行（要能复算验真）",
  );
  assert.equal(
    outsideWrite("bash", { command: `ls ${SRC}/outbox` }, AS_LAB2),
    null,
    "★ 列目录必须放行",
  );

  // 写 —— 那是被分析的对象，必须全拦
  assert.notEqual(
    outsideWrite("write", { path: `${SRC}/outbox/HACK.md` }, AS_LAB2),
    null,
    "★★★ 写第一集群的产物必须拦住",
  );
  assert.notEqual(
    outsideWrite("edit", { path: `${SRC}/outbox/P44.md` }, AS_LAB2),
    null,
    "★★★ 改第一集群的结论必须拦住",
  );
  assert.notEqual(
    outsideWrite("bash", { command: `rm ${SRC}/outbox/P44.md` }, AS_LAB2),
    null,
    "★★★ 删第一集群的文件必须拦住",
  );
  assert.notEqual(
    outsideWrite("bash", { command: `echo x > ${SRC}/outbox/N.md` }, AS_LAB2),
    null,
    "★★★ 重定向写第一集群必须拦住",
  );
});

test("★ 第二集群：自己的空间照常可写（收窄不能误伤干活）", () => {
  assert.equal(outsideWrite("write", { path: `${OWN}/outbox/P1.md` }, AS_LAB2), null);
  assert.equal(outsideWrite("bash", { command: "echo hi > work/x.txt" }, AS_LAB2), null);
  assert.equal(outsideWrite("bash", { command: `rm ${OWN}/work/old.jsonl` }, AS_LAB2), null);
});

test("★ 第一集群：写自己完全不受影响（它是源头，没有只读对象）", () => {
  assert.equal(
    outsideWrite("write", { path: `${SRC}/outbox/P200.md` }, AS_LAB3B),
    null,
    "★★ 第一集群写自己必须放行 —— 加了这条不能把它锁住",
  );
  assert.equal(outsideWrite("bash", { command: `rm ${SRC}/work/x.jsonl` }, AS_LAB3B), null);
});

test("★ 仓库主体仍然只读（原有行为没被改坏）", () => {
  assert.notEqual(
    outsideWrite("write", { path: "D:/repo/src/index.ts" }, AS_LAB2),
    null,
    "★ 仓库主体对两边都只读",
  );
  assert.notEqual(outsideWrite("write", { path: "D:/repo/dev/docs/DESIGN.md" }, AS_LAB3B), null);
});
