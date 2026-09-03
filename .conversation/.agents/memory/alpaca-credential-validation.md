---
name: Alpaca credential validation
description: Paper credentials may exist in the environment while still being rejected by Alpaca.
---

Treat credential presence and credential health as separate states. A pair of populated Alpaca secrets is not proof that the paper account is accessible; validate with the paper account endpoint and fail closed on authorization errors rather than silently switching to simulated trading.

**Why:** A saved key/secret pair can be mismatched, revoked, or copied incorrectly, and reporting it as connected creates unsafe operator expectations.

**How to apply:** Keep demo mode only for environments with no credentials. When credentials are present but rejected, surface a clear needs-attention state and preserve paper-only execution.