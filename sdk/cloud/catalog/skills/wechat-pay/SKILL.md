---
name: wechat-pay
scope: persistence
description: Collect a real WeChat Pay (微信支付) payment from inside an IM session. Use when a user in the conversation explicitly asks to pay / 下单 / 付款 / 收款 and has stated (or confirmed) an amount. Posts a Native 扫码 QR card into the session (which the bridge forwards to bound WeChat users), then confirms when the payment lands. Executes via `cloud pay create` / `cloud pay status`. This is the RUNTIME收款 capability — distinct from the wechatpay-skills coding-assistant skill, which only helps developers write integration code.
---

# WeChat Pay (收款) in a session

This skill lets you collect a **real** WeChat Pay payment from a participant of the
current conversation. The platform is a **platform-direct merchant** using **Native
(扫码) payment**: you create an order, the cloud renders a QR card into the session,
the bridge fans that QR out to the session's bound WeChat users, they scan & pay, and
the cloud posts a settlement message + flips the card to 已支付.

## ⛔ Guardrails — real money

1. **Only on explicit user request with an explicit amount.** Never invent a price,
   never round, never "helpfully" collect more. If the amount is unclear, ASK in the
   conversation first.
2. **Never alter the amount** the user agreed to.
3. **One order per intent.** Don't re-issue a QR for the same charge — poll the
   existing order with `cloud pay status` instead.
4. This is **online-only**. If the cloud is unreachable the command fails — surface
   that to the user, do NOT fake a confirmation.

## When to use

- A user says "帮我下单 / 付款 / 收款 ¥X" or agrees to a quoted price.
- You're a 客服 / 销售 / 咨询 agent closing a paid action.

## CLI

```bash
# Create an order + post the QR card (amount in YUAN on the CLI)
cloud pay create --conversation <conversationId> --amount 9.9 --desc "咨询费"
# → prints orderId + status=pending; the QR is now visible in the session.

# Poll until paid (the cloud also posts a "✅ 已收款" message when it lands)
cloud pay status <orderId>
# → status: pending | succeeded | expired | closed
```

`--conversation` is the current session id. Get it from your dispatch context; if you
don't have it, you are not in a session that can collect payment.

## Flow

1. Confirm the amount + purpose with the user (in YUAN).
2. `cloud pay create --conversation <id> --amount <yuan> --desc "<purpose>"`.
3. Tell the user the QR is posted and to scan it in WeChat.
4. Poll `cloud pay status <orderId>` (or wait for the settlement message). On
   `succeeded`, confirm to the user and continue your task.
5. The Native QR expires in ~2h. If it expires before payment, create a new order.

## Notes

- Amounts: CLI takes **yuan** (`9.9`); the API stores **分**. ¥9.9 → 990 分.
- Errors surface the WeChat `code` + `Request-Id` — if a user reports a failure, that
  `Request-Id` is exactly what the wechatpay-skills troubleshooting flow consumes.
