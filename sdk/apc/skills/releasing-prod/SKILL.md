---
name: releasing-prod
description: Use when 把已验证内容发到 Prismer 生产（prod.docbrew.cn / prismer.cloud / APP_ENV=prod），或听到「发生产 / 上 prod / 发版上线 / 打 ali-k8s-prod tag」。涉及 main 部署、prod 迁移、manual deploy 审批点时必读。
---

# 发生产（releasing-prod）

## 铁律

**main 是生产的唯一通道；prod 内容必须先在 test 同版本验证通过。**
`ali-k8s-prod-*` tag 只打 main merge 后的 commit。prod deploy job 是 manual——手动那一下就是 owner 审批点，代点前必须有 owner 原话授权。

## 门槛顺序（逐步过，任何一步红则停）

1. **test 前置**：同内容已在 test 验证（发版记录 / 管线号 / 冒烟结果可查）。无记录不发。
2. **owner 授权**：发 prod 的原话指令在案。
3. **本地门**：干净树 + `npm run check` 0 errors。
4. **版本**：`cat /VERSION`；prod tag 版本 = 发 test 的版本或其后；禁止四段版本制造镜像漂移。
5. **merge**：develop → main MR（描述含 test 验证证据），merge。
6. **迁移**：受保护 tag `prod-schema-migrate-YYYYMMDD-vX.Y.Z` 管线：`prod_incremental_schema_preflight`（产出唯一 `planSha256`）→ manual `prod_incremental_schema_apply`（resource_group: prod-schema 串行）。**先迁后发**；任何本地机器不碰 prod 库。
7. **发版**：tag `ali-k8s-prod-YYYYMMDD-vX.Y.Z` → build_job_prod → `ali_k8s_deploy_prod`（manual，授权后点）。
8. **节流 + 留证 + 冒烟**：只留目标链；prod 双域（prismer.cloud / prod.docbrew.cn）冒烟；**回滚预案（镜像 digest 回退路径）先写进汇报再动手**。

## 禁区

- prod tag 指向非 main commit（feature/develop 直发）
- 未经 owner 授权点 manual deploy / manual apply
- prod 库任何本地直连
- 迁移未过 preflight 直接 apply

## 合理化反驳表

| 借口 | 现实 |
|---|---|
| 「test 都绿了，prod 肯定行」 | prod 变更门是授权门不是技术门；跳过授权=不可回退事故。 |
| 「先发了再看着办」 | prod 没有「看着办」；回滚预案是发版的一部分，不是事后补的。 |
| 「迁移很小，直接上」 | prod 迁移走 planSha256 受控管线；「小」不是绕过 preflight 的理由。 |
| 「owner 大概会同意」 | 「大概」不是授权。停下来问。 |

## 红旗（出现即停）

- 无 test 验证记录
- 无 owner 原话授权
- 没写回滚预案就想点 manual
- tag 与 main commit 不符

## 归宿

源头 = `sdk/apc/skills/releasing-prod/SKILL.md`（2026-09-07 归入 apc，随仓库版本控制）；`.claude/skills/` 为 agent 运行时安装副本，改源头后同步复制。
