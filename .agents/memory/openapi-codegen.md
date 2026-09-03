---
name: OpenAPI code generation
description: Compatibility guidance for the workspace OpenAPI → Orval → Zod generation path.
---

When changing the API contract, verify generated Zod output against the installed Zod major version. In this workspace, declaring OpenAPI integer fields caused Orval to emit the standalone `zod.int()` helper, which is unavailable in the installed Zod 3 runtime; numeric fields should use a compatible schema until the dependency is upgraded deliberately.

**Why:** The API contract can generate successfully while the shared library typecheck fails, blocking every dependent package.

**How to apply:** Run the API-spec codegen command and the workspace typecheck after contract changes; treat generated-client compatibility errors as a dependency/version issue rather than a server implementation issue.