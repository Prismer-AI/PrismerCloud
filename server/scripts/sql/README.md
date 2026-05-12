# Prismer Cloud SQL Scripts

## Overview

SQL migration scripts for creating `pc_*` tables used by the self-host frontend.

These scripts are automatically executed by `docker/init-db.sql` during `docker compose up`. You generally don't need to run them manually.

## Scripts

| File | Purpose |
|------|---------|
| `010_create_pc_tables.sql` | Usage records + credits tables |
| `020_create_billing_tables.sql` | Payment methods, payments, subscriptions |
| `030_create_pc_api_keys.sql` | API key management |
| `040_create_pc_users.sql` | User accounts (self-host auth) |

## Manual Execution

```bash
# If running MySQL locally (not via docker compose):
mysql -h localhost -P 3306 -u prismer -p prismer_cloud < scripts/sql/010_create_pc_tables.sql
```

## Table Namespaces

- **`pc_*`** — Frontend tables (managed by these scripts)
- **`im_*`** — IM Server tables (managed by Prisma / `src/im/sql/`)
