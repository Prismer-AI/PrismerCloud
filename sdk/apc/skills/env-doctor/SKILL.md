---
name: env-doctor
description: Diagnose the local dev machine before any APC loop step — run apc env doctor, classify each failure into a fault domain, apc env up to auto-fix what is safe, then fingerprint. Keeps env faults out of SUT verdicts.
license: MIT
scope: common
compatibility:
  - claude-code
  - prismer-sdk
allowed-tools:
  - Bash
metadata:
  category: environment
---

# env-doctor

诊断本机开发环境，把**环境故障**与**被测代码红（SUT red）**彻底分域——这是 APC 一切循环步骤的地基（`apc/06` 环境脚手架 · `apc/00` §3 不变量 5）。

**什么时候用**：任何 APC 循环步骤开工前；或 test-runner 报出 `env_blocked`、dispatch 失败、诊断"为什么这台机器跑不起来"时。

铁律：`apc env doctor` 判红是**环境红**，不是产品 bug。你的产出是一份逐项 pass/fail 的诊断 + 每个红项的**故障域分类** + 可自动化项已拉起的证据。绝不把环境红说成"代码坏了"。

## 工具契约（先记死，签名以此为准）

> **命令形态（承重，别猜）**：`apc` 不在 PATH——它是 `package.json` 的 npm script（`tsx sdk/apc/bin/apc.ts`）。
> 在 agent 的 cwd（仓库根）里，**一律用 `npx tsx sdk/apc/bin/apc.ts <sub>` 直接跑**（stdout 是纯 JSON，不被 npm banner 污染）。下表用 `apc` 作简写，实跑请替换成 `npx tsx sdk/apc/bin/apc.ts`。

| 命令 | 作用 | stdout | 退出码 |
| --- | --- | --- | --- |
| `apc env doctor` | 只读跑完 env-manifest 四段，逐项 pass/fail + fix-hint | **结构化 JSON**（消费者契约） | `0` 全绿 · `78` env_blocked（存在环境红） |
| `apc env up --safe [--dry-run] [--only=a,b]` | 幂等拉起**可自动化的轻量项**；`--safe` 下 heavy 步（colima / dev-stack / kind / npm ci / prisma / migrations）**不自动跑**，只归 `manual[]` 出 fix-hint | JSON 报告 | `0` ok · `1` 有步骤 failed |
| `apc env fingerprint` | 环境指纹（机器等价性证明） | JSON 指纹 | `0` |

- **`apc env doctor` 的 exit 78 是承重信息**：它表示"存在环境红"，不是崩溃。一项探针崩了也不塌全轮——doctor 逐项 `try/catch`，其它项照常给结论。
- **stdout 是纯 JSON**，人读摘要走 stderr。解析结果一律从 stdout 的 JSON 取，**不要**从人读摘要正则抠。
- **dispatch 语境铁律（apc/11 §0.17 缺口1）**：你是被一次 dispatch 拉起跑诊断的，**不是人坐在终端做环境自举**。**绝不跑不带 `--safe` 的 `apc env up`**——它的 docker 步会 `colima start`（可耗时数分钟），在非交互 agent 环境里会 block 直到被 reaper abort，本次运行就白跑了。要拉起环境只用 `apc env up --safe`（heavy 步只出 fix-hint 不执行）。

## Procedure

### 1. 诊断（doctor）

```bash
npx tsx sdk/apc/bin/apc.ts env doctor > /tmp/apc-doctor.json
echo "doctor exit=$?"
```

从 `/tmp/apc-doctor.json` 读结构化结果，真实 schema（**字段名以此为准**）：

- 顶层：`{ envStatus, exitCode, summary:{pass,fail,skip,total}, failed:[<itemId>...], undetected:[<itemId>...], items:[...] }`。
- 每个 `items[]` 元素：`{ item(id,如 "toolchain.node"), label, section(infra|toolchain|secrets), status(pass|fail|skip), detail, fixHint, strength }`。
- `failed[]` = 所有 `status:fail` 的 item id；`undetected[]` = 所有 `status:skip` 的 item id。

判据：`summary.total == summary.pass + summary.fail + summary.skip == items.length`——一项崩不塌全轮。

- `exit 0` → 环境全绿，产出"逐项 pass"的诊断，收工。
- `exit 78` → 存在环境红（`failed[]` 非空），进第 2 步分类。

### 2. 分类（故障域）

**故障域 = item 的 `section` 字段**（不是另算的）。把每个 `status:fail` 的 item 按 `section` 归组，逐项列出 `{ item, section, detail, fixHint }`：

| 故障域（section） | 典型 item | 处置 |
| --- | --- | --- |
| `infra`（本机基础设施） | `infra.mysql-3307` / `infra.redis-6380` / `infra.nacos` / `infra.kind-<cluster>` / `infra.cloud-dev-server` 未起 | `apc env up` 可拉起 |
| `toolchain`（工具链版本） | `toolchain.node` major / 锁定 claude binary 版本不符 / 网关口径 | `apc env up` 装锁定 binary；node 需人手 |
| `secrets`（凭据/密钥） | `secrets.env-local-required-keys` 缺 `SKILL_CONFIG_ENC_KEY` / `IDENTITY_KMS_KEY` 等 | **不代办**——只报 `fixHint`，等人按提示补 |
| `project`（工程态） | `project.node-modules-lockfile` / `project.prisma-clients` / `project.mysql-migrations-pending` / `project.version-alignment` | 多数是 heavy 步，`--safe` 下归 `manual[]` 出 fix-hint |

> **段是四段不是三段**：`sdk/apc/env/manifest.ts` 的四段清单是 `infra` / `toolchain` / `secrets` / `project`（`ENV_MANIFEST` 由这四组拼成）。分类只认 item 的 `section` 字段，别把 `project` 项硬塞进前三域。

**判据**：`secrets` 域的红**永远不自动修**（`apc env up` 只出 fix-hint，凭据不代办，`apc/00` §3）。别声称已修一个 secrets 项。

### 3. 拉起可自动化项（up，**dispatch 语境用 `--safe`**）

```bash
npx tsx sdk/apc/bin/apc.ts env up --safe
echo "up exit=$?"
```

- `--safe` 是 dispatch 语境的强制形态：heavy 步（colima / dev-stack / kind / npm ci / prisma / migrations）**不自动跑**，只归 `manual[]` 出 fix-hint。轻量幂等步（配置目录 / bare 替身）照跑。**这样本步永不 block。**
- `apc env up` 是**幂等**的：第二次跑对已就绪项全 `skip`。
- 只对 `infra` / `toolchain` 里可自动化的项生效；`secrets` 域只出 fix-hint。
- 修完回到第 1 步重跑 `apc env doctor` 确认红项减少（红→绿可逆才算真修，恒红是没修）。heavy 步落在 `manual[]` 属预期——它们要人在交互终端跑不带 `--safe` 的 up，不由本次 dispatch 代办。

### 4. 指纹（fingerprint）

```bash
npx tsx sdk/apc/bin/apc.ts env fingerprint > /tmp/apc-fingerprint.json
echo "fingerprint exit=$?"
```

指纹是机器等价性证明——同一环境两台机器指纹应等价。收工时附上它。

## 输出契约（机器判据按这个复验，别自由发挥格式）

本 skill 的验收判据不再是「报告里出现了 `infra` / `fail: 2` 这些词」——旧判据里 `\b(infra|toolchain|secrets?)\b` 一个词就能让「故障域已分类」变绿，`(pass|fail|skip)…\d+` 一个数字就能冒充「逐项报告」。现在判据找的是**每一个 item 自己那一行**，并把该行的引用**读回磁盘复核**（`structured-criteria.ts` 的 `dimension-coverage`）。

**逐项作答**（每个 item **独占一行 + 用它的 item id 当 key**，值给：真实 status → 故障域 → 关键 detail/fixHint → 该 item 在 manifest 里的**声明行**）：

```
- infra.docker-daemon: pass | domain=infra | sdk/apc/env/manifest.ts:165
- infra.mysql-3307: pass | domain=infra | MySQL 8.0.46 真握手 | sdk/apc/env/manifest.ts:178
- toolchain.node: fail | domain=toolchain | node 23.9.0 major 23 ≠ pin 20 | fixHint: nvm use 20 | sdk/apc/env/manifest.ts:318
- toolchain.hermes-gateway-models: skip | domain=toolchain | 未检测（无凭据）| sdk/apc/env/manifest.ts:408
- secrets.env-local-required-keys: fail | domain=secrets | 本地凭据缺失，只出 fixHint 不代办 | sdk/apc/env/manifest.ts:449
- project.mysql-migrations-pending: fail | domain=project | 1 条 pending | fixHint: npm run db:migrate | sdk/apc/env/manifest.ts:603
```

**判据钉住的 21 个 item id**（= `ENV_MANIFEST` 除 `infra.kind-<cluster>`）：`infra.docker-daemon` · `infra.mysql-3307` · `infra.mysql-migration-ledger` · `infra.redis-6380` · `infra.nacos` · `infra.cloud-dev-server` · `toolchain.node` · `toolchain.docker-compose` · `toolchain.kubectl` · `toolchain.kind-cli` · `toolchain.claude-code-binary-pin` · `toolchain.hermes-binary` · `toolchain.hermes-gateway-models` · `secrets.env-local-required-keys` · `secrets.ota-ui-signing-key` · `project.node-modules-lockfile` · `project.prisma-clients` · `project.mysql-migrations-pending` · `project.version-alignment` · `project.claude-config-dir` · `project.bare-repo-mirror`。

> `infra.kind-<cluster>` 的 id 由 `CLUSTER_NAME` 拼（manifest.ts:249），**不进固定判据**（否则改环境变量会让如实报告变红）——但它照样要出现在你的逐项表里。

**故障域汇总**（四段各独占一行，引用该段清单在 manifest 里的起始行）：

```
- domain-infra: 7 项 → pass 7 / fail 0 / skip 0 | sdk/apc/env/manifest.ts:163
- domain-toolchain: 7 项 → pass 5 / fail 1 / skip 1 | sdk/apc/env/manifest.ts:316
- domain-secrets: 2 项 → pass 1 / fail 1（凭据永不自动修，只出 fixHint）| sdk/apc/env/manifest.ts:447
- domain-project: 6 项 → pass 5 / fail 1 | sdk/apc/env/manifest.ts:569
```

判据强制三条：

1. 每个 key **必须有自己那一行**——「报告里别处提过 `toolchain.node`」不算作答（漏一项判红）。
2. 每行的值**必须带至少一条能在磁盘上复核的 `path:line`**（文件存在、行号在范围内、该行非空）——`rg -n "id: 'toolchain.node'" sdk/apc/env/manifest.ts` 出来的行号，**别猜**。
3. 只有真不适用的行才写 `N/A — <理由 ≥20 字符>`；**真 item 不许以 `无` / `N/A` 开头**（会被当成"这项不适用"），一律以真实 `pass`/`fail`/`skip` 开头。

引用写法：**必须 repo-root-relative**（`sdk/apc/env/manifest.ts:318`，不要简写、不要绝对路径）；`rg -c` 出的 `path:12` 是**命中计数不是行号**，要写就写 `count=12`。

**诚实边界（`dimension-coverage` 这条判据管到哪）**：它复核的是「每项都作答了 + 引用真实存在」，**不复核 status 本身**。~~把 `fail` 写成 `pass` 骗不过重跑 doctor 的人，但骗得过这条判据。~~ ← **已由下面的 ③ 收窄**（2026-07-26）。

**③ 原始产物 + 七行判定声明**（`json-claim` 复核；**这条是本 skill 的承重判据**）

把 `apc env doctor` 的 stdout **原样贴进一个 fenced JSON 块**（别摘录、别改写），并给出七行：

```
DOCTOR-EXIT: 78
DOCTOR-VERDICT: env-blocked
DOCTOR-PASS: 16
DOCTOR-FAIL: 5
DOCTOR-SKIP: 1
DOCTOR-TOTAL: 22
DOCTOR-FAILED-IDS: toolchain.node,secrets.env-local-required-keys,project.mysql-migrations-pending
DOCTOR-UNDETECTED-IDS: toolchain.hermes-gateway-models
```

checker 重新解析产物并核对：

- **五个计数与退出码必须逐字等于产物字段**（`exitCode` / `summary.pass|fail|skip|total`）。**这条直接管住了本文档自己犯过两次的错**：apc/12 §0 的 doctor 计数先写「20 pass / 2 fail」、更正为「18 pass / 3 fail / 1 skip」、今天实测又是 `16/5/1` —— 报计数而不报全、且不与产物对账，账就会漂。
- **`DOCTOR-VERDICT` 由 `exitCode` 派生**，只有两个合法值：`0 ⇒ all-green`、`78 ⇒ env-blocked`。
- **`exitCode` 只允许 `0|78`** —— 任何别的值意味着 doctor 自己崩了（"一项崩不塌全轮"这条不变量的机器化）。
- **`DOCTOR-FAILED-IDS` / `DOCTOR-UNDETECTED-IDS` 必须逐字列出产物里的真实 id 集合**（逗号分隔、保持产物顺序）。把某一项的 `fail` 写成 `pass` 会与这份清单直接冲突。
- 三条 implication：`exitCode=78 ⇒ envStatus='env_blocked'`；`exitCode=0 ⇒ failed 为空`；`envStatus='ok' ⇒ failed 为空`。

> **仍未被判据覆盖的（诚实）**：**逐项 status 与汇总计数之间的自洽性**没有自动交叉验证 —— checker 能确认 `DOCTOR-FAIL: 5` 等于产物，也能确认 failed 清单，但不会去数你上面那 22 行里有几行写了 `fail`。一个同时篡改逐项行、汇总行与清单的伪造者仍能自洽。**skip 不是 pass**：`total == pass+fail+skip` 要自己核，别把 skip 并进 pass 报。

## 产出（副作用 oracle，报告里必须给）

1. **逐项 pass/fail 诊断**：从 `apc env doctor` 的 stdout JSON 逐个 item 列 `{item, status, section}` + `summary`；证明"一项崩不塌全轮"（`summary.total == pass+fail+skip == items.length`）。
2. **故障域分类**：每个 `failed[]` 项按其 `section` 归到 `infra|toolchain|secrets`，带 `detail`+`fixHint`。
3. **up 幂等证据**：`apc env up --safe` 退出码 + 已就绪项全 skip（heavy 未修项归 `manual[]`，属预期）。
4. **fingerprint JSON**：`apc env fingerprint` 产物。

**不许**：把 `secrets` 红当作已修；把 doctor 的 exit 78 当作 SUT 红上报；从人读摘要抠结论而非读 stdout JSON。

## 诚实边界

- `apc env doctor` 无 task 上下文（它不在一次 dispatch 的 task 里跑），所以下方调用回执的 `cloud skill ack` 会 **exit 3（无 task 上下文）**——这是契约限制，不是失败。本次运行**没有回执**，报告里不得声称已 ack。
- `secrets` 域缺 key 读作"这台机的 `.env.local` 缺"，不读作"运行时一定拿不到"（Nacos 可能有）——按 `fixHint` 交人。

<!-- APC-ACK:v1 -->

## 调用回执（APC 平台方运营纪律 · 自动注入，勿手改）

执行本 skill 的**第一步**，先落一条调用回执：

```bash
cloud skill ack env-doctor --task "$PRISMER_TASK_ID"
```

**按退出码分流**（这条命令的退出码是承重信息，禁止用 `||` 兜底、`; true`、
`set +e` 或重定向把它抹掉）：

| exit | 含义 | 你要做的 |
| --- | --- | --- |
| `0` | 回执已落库（`im_task_logs.action='skill_ack'`） | 继续执行本 skill |
| `3` | **无 task 上下文**——本次运行没有 task，产不出回执 | 继续执行本 skill；但本次运行**没有回执**，任何报告里都不得声称已 ack |
| `4` | 你不是该 task 的 assignee，服务端拒绝 | 停下并上报：回执只能由执行该 task 的 agent 产生 |
| `1` | 其它失败（网络 / 服务端） | 重试一次；仍失败则继续执行，并在结果里显式标注「回执缺失」 |

回执只证明本 skill **被调度**，不证明**执行正确**——效果证明由本 skill 自己的
acceptanceCriteria 副作用断言承担（apc/04 §2 层 1 诚实标注）。

<!-- /APC-ACK:v1 -->
