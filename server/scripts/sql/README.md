# Prismer Cloud SQL 脚本

## 设计原则

```
✅ 不修改任何现有表 (users, api_keys, usage_records 等)
✅ 新表使用 pc_ 前缀，与后端开发完全解耦
✅ 后续迁移时，只需将数据迁移到后端正式表
```

## 数据库连接

```bash
Host: REDACTED-DB-HOST
Port: 3306
User: prismer
Password: REDACTED-PC-PASSWORD
Database: prismer_info
```

## 脚本列表

| 文件 | 用途 | 影响范围 |
|------|------|----------|
| `010_create_pc_tables.sql` | 创建前端先行表 (Usage/Credits) | ✅ 仅创建 pc_ 新表 |
| `010_rollback.sql` | 回滚 Usage/Credits 表 | ✅ 仅删除 pc_ 新表 |
| `020_create_billing_tables.sql` | 创建 Billing 相关表 | ✅ 仅创建 pc_ 新表 |
| `020_rollback.sql` | 回滚 Billing 表 | ✅ 仅删除 pc_ 新表 |

**已废弃的脚本**（不要执行）：
- `000_check_schema.sql` - 仅检查，可安全执行
- `001_*.sql`, `002_*.sql`, `003_*.sql` - 会修改现有表，**不要执行**

## 执行命令

```bash
# 创建前端先行表 (Usage/Credits)
mysql -h REDACTED-DB-HOST -P 3306 -u prismer -pREDACTED-PC-PASSWORD prismer_info < scripts/sql/010_create_pc_tables.sql

# 创建 Billing 表 (Payment/Subscription)
mysql -h REDACTED-DB-HOST -P 3306 -u prismer -pREDACTED-PC-PASSWORD prismer_info < scripts/sql/020_create_billing_tables.sql

# 回滚 Usage/Credits（如需要）
mysql -h REDACTED-DB-HOST -P 3306 -u prismer -pREDACTED-PC-PASSWORD prismer_info < scripts/sql/010_rollback.sql

# 回滚 Billing（如需要）
mysql -h REDACTED-DB-HOST -P 3306 -u prismer -pREDACTED-PC-PASSWORD prismer_info < scripts/sql/020_rollback.sql
```

## 新建表说明

### pc_usage_records

API 使用量记录（前端先行版），用于：
- Dashboard 统计图表
- Recent Tasks 活动列表
- 计费依据

```sql
pc_usage_records
├── id              VARCHAR(36)     -- UUID 主键
├── user_id         BIGINT UNSIGNED -- 用户 ID (对应 users.id，无外键)
├── task_id         VARCHAR(64)     -- 任务 ID (唯一)
├── task_type       VARCHAR(32)     -- load/save/parse
├── input_type      VARCHAR(16)     -- url/urls/query/file
├── input_value     TEXT            -- 输入值
├── exa_searches    INT             -- Exa 搜索次数
├── urls_processed  INT             -- 处理 URL 数
├── urls_cached     INT             -- 缓存命中
├── urls_compressed INT             -- 新压缩数
├── tokens_input    BIGINT          -- LLM 输入 tokens
├── tokens_output   BIGINT          -- LLM 输出 tokens
├── processing_time_ms BIGINT       -- 处理时间 (ms)
├── pages_parsed    INT             -- 解析页数 (Parse)
├── images_extracted INT            -- 图片数 (Parse)
├── parse_mode      VARCHAR(16)     -- fast/hires/auto
├── search_credits  DECIMAL(10,4)   -- 搜索费用
├── compression_credits DECIMAL     -- 压缩费用
├── parse_credits   DECIMAL(10,4)   -- 解析费用
├── total_credits   DECIMAL(10,4)   -- 总费用
├── sources_json    JSON            -- 来源详情
├── error_message   TEXT            -- 错误信息
├── status          VARCHAR(16)     -- completed/failed
├── created_at      TIMESTAMP
└── updated_at      TIMESTAMP
```

### pc_credit_transactions

积分交易记录（前端先行版）：

```sql
pc_credit_transactions
├── id              VARCHAR(36)     -- UUID 主键
├── user_id         BIGINT UNSIGNED -- 用户 ID (无外键)
├── type            VARCHAR(16)     -- usage/purchase/refund/bonus
├── amount          DECIMAL(10,4)   -- 金额 (+增加/-扣除)
├── balance_after   DECIMAL(10,4)   -- 交易后余额
├── description     VARCHAR(255)    -- 描述
├── reference_type  VARCHAR(32)     -- usage_record/payment/admin
├── reference_id    VARCHAR(64)     -- 关联 ID
└── created_at      TIMESTAMP
```

### pc_user_credits

用户积分余额快照（避免每次聚合计算）：

```sql
pc_user_credits
├── user_id         BIGINT UNSIGNED -- 用户 ID (主键)
├── balance         DECIMAL(10,4)   -- 当前余额 (默认 100)
├── total_earned    DECIMAL(10,4)   -- 累计获得
├── total_spent     DECIMAL(10,4)   -- 累计消费
├── plan            VARCHAR(32)     -- free/pro/enterprise
├── created_at      TIMESTAMP
└── updated_at      TIMESTAMP
```

## 与现有系统的关系

```
现有表 (后端管理，不修改)          前端先行表 (新建，pc_ 前缀)
┌─────────────────────────┐      ┌─────────────────────────┐
│ users                   │      │ pc_user_credits         │
│   id (BIGINT PK)  ◄─────┼──────┼─► user_id (引用，无FK)  │
│   email                 │      │   balance               │
│   ...                   │      │   plan                  │
└─────────────────────────┘      └─────────────────────────┘
           │                                │
           │                                │
┌─────────────────────────┐      ┌─────────────────────────┐
│ api_keys (已联调完成)   │      │ pc_usage_records        │
│   user_id → users.id    │      │   user_id (引用，无FK)  │
└─────────────────────────┘      │   task_id, task_type    │
                                 │   total_credits, ...    │
┌─────────────────────────┐      └─────────────────────────┘
│ usage_records (后端开发) │               │
│   (不修改，解耦)        │      ┌─────────────────────────┐
└─────────────────────────┘      │ pc_credit_transactions  │
                                 │   user_id (引用，无FK)  │
                                 │   amount, balance_after │
                                 └─────────────────────────┘
```

## 后续迁移计划

当后端完成正式实现后：

1. **数据迁移**：将 `pc_*` 表数据迁移到后端正式表
2. **切换 API**：关闭 Feature Flag，切换到后端代理模式
3. **清理**：执行 `010_rollback.sql` 删除 `pc_*` 表

## 后续开发计划

表创建完成后：

1. **配置数据库连接** - `src/lib/db.ts` (mysql2 + 连接池)
2. **实现 Usage Record API** - 写入 `pc_usage_records`，更新 `pc_user_credits`
3. **实现 Activities API** - 读取 `pc_usage_records`
4. **实现 Dashboard Stats API** - 聚合查询

详见 [FRONTEND-FIRST-IMPLEMENTATION.md](../../src/app/docs/FRONTEND-FIRST-IMPLEMENTATION.md)

---

## Billing 相关表 (020_*)

### pc_payment_methods

用户支付方式（银行卡、支付宝等）：

```sql
pc_payment_methods
├── id                      VARCHAR(36)     -- UUID 主键
├── user_id                 BIGINT UNSIGNED -- 用户 ID (无外键)
├── stripe_payment_method_id VARCHAR(64)    -- Stripe PM ID (pm_xxx)
├── stripe_customer_id      VARCHAR(64)     -- Stripe Customer ID (cus_xxx)
├── type                    ENUM            -- card/alipay/wechat
├── card_brand              VARCHAR(32)     -- visa/mastercard/amex
├── card_last4              CHAR(4)         -- 卡号后四位
├── card_exp_month          TINYINT         -- 过期月份
├── card_exp_year           SMALLINT        -- 过期年份
├── card_funding            VARCHAR(16)     -- credit/debit/prepaid
├── wallet_email            VARCHAR(255)    -- 支付宝/微信邮箱
├── is_default              BOOLEAN         -- 是否默认
├── is_active               BOOLEAN         -- 是否有效
├── created_at              TIMESTAMP
└── updated_at              TIMESTAMP
```

### pc_payments

支付/充值记录：

```sql
pc_payments
├── id                      VARCHAR(36)     -- UUID 主键
├── user_id                 BIGINT UNSIGNED -- 用户 ID (无外键)
├── stripe_payment_intent_id VARCHAR(64)    -- PaymentIntent ID (pi_xxx)
├── stripe_charge_id        VARCHAR(64)     -- Charge ID (ch_xxx)
├── stripe_invoice_id       VARCHAR(64)     -- Invoice ID (in_xxx)
├── payment_method_id       VARCHAR(36)     -- 关联 pc_payment_methods.id
├── payment_method_type     ENUM            -- card/alipay/wechat
├── amount_cents            INT UNSIGNED    -- 金额 (分)
├── currency                CHAR(3)         -- USD/CNY
├── credits_purchased       DECIMAL(10,2)   -- 购买 credits 数
├── type                    ENUM            -- topup/subscription/one_time
├── status                  ENUM            -- pending/succeeded/failed/...
├── description             VARCHAR(255)    -- 支付描述
├── failure_reason          VARCHAR(255)    -- 失败原因
├── invoice_pdf_url         TEXT            -- 发票 URL
├── created_at              TIMESTAMP
└── completed_at            TIMESTAMP
```

### pc_subscriptions

订阅记录：

```sql
pc_subscriptions
├── id                      VARCHAR(36)     -- UUID 主键
├── user_id                 BIGINT UNSIGNED -- 用户 ID (无外键)
├── stripe_subscription_id  VARCHAR(64)     -- Subscription ID (sub_xxx)
├── stripe_customer_id      VARCHAR(64)     -- Customer ID (cus_xxx)
├── plan                    ENUM            -- free/pro/enterprise
├── price_cents             INT UNSIGNED    -- 月费 (分)
├── credits_monthly         INT UNSIGNED    -- 每月 credits
├── status                  ENUM            -- active/canceled/past_due/...
├── current_period_start    TIMESTAMP       -- 当前周期开始
├── current_period_end      TIMESTAMP       -- 当前周期结束
├── canceled_at             TIMESTAMP       -- 取消时间
├── created_at              TIMESTAMP
└── updated_at              TIMESTAMP
```

## 完整表结构图

```
现有表 (后端管理)              前端先行表 (pc_ 前缀)
┌──────────────────┐          ┌──────────────────────┐
│ users            │          │ pc_user_credits      │
│   id (PK)  ◄─────┼──────────┼─► user_id           │
└──────────────────┘          └──────────────────────┘
         │                             │
         │                    ┌────────┴────────┐
         │                    ▼                 ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐
│ api_keys         │  │ pc_usage_records │  │ pc_credit_transactions│
│ (已联调完成)     │  │ (API 使用量)     │  │ (积分变动)            │
└──────────────────┘  └──────────────────┘  └──────────────────────┘

                      ┌──────────────────────┐
                      │ pc_payment_methods   │
                      │ (支付方式)           │
                      └──────────┬───────────┘
                                 │
                      ┌──────────┴───────────┐
                      ▼                      ▼
               ┌──────────────────┐  ┌──────────────────┐
               │ pc_payments      │  │ pc_subscriptions │
               │ (支付记录)       │  │ (订阅记录)       │
               └──────────────────┘  └──────────────────┘
```
