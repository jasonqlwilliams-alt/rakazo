# AGENTS.md

- This is a public repository: assume all tracked content and diffs are public. Never commit secrets, `.env` files, private URLs, personal/customer data, or real production data; use fake placeholders. Review `git status` and the staged diff before committing, and never force-add ignored files. If private data appears, stop and alert the maintainer.
- Rakazo targets web, Electron desktop, and Expo mobile; Electron hosts the web UI. Consider every surface when changing features or contracts.
- Prefer shared packages for domain logic, contracts, API behavior, and reusable UI. Keep genuinely native navigation, storage, permissions, and interactions platform-specific.
- Treat auth, secret handling, sandbox boundaries, host commands, and integrations as security-sensitive. Keep tests deterministic and offline by default.
- Memory document paths are scope-free relative paths; scope is a separate field. Every path reaching the store goes through `resolveMemoryPath` in `packages/adapter-kit/src/memory-path.ts`, and `remember` appends while `replace_memory_document` overwrites. Never render a memory path concatenated with its scope, and never pass a model-supplied path straight to `commit`.
- A bot's `description` is a short blurb; `instructions` is its persona (the system prompt). Neither field defaults from the other, on any surface. Build both payloads with `botCreateInput`/`botSettingsPatch` in `apps/web/src/lib/bot-fields.ts`; a screen that has no instructions editor must send no `instructions` field. The guard in `apps/web/src/lib/bot-fields.test.ts` greps `Shell.tsx` for the literal defect, so keep that string out of comments too. The API still accepts `instructions` on update, so this contract is a client obligation on every surface (web, mobile, desktop).
- A thread message the product writes on a bot's behalf (spawn and seed openers) must be `role: "system"` with a `kind: "meta"` block. `kind: "text"` + `role: "user"` is the one combination that renders in the human's own chat bubble (`MessageView` in `apps/web/src/pages/Shell.tsx`), so a user/text opener shows the user a turn they never typed; `role: "system"` alone still leaves a bot bubble. Guarded by `apps/web/src/pages/message-view.test.tsx`.
- After creating a pull request, stay with it until CI and automated review bots have finished. Poll checks, reviews, review threads, and PR comments at roughly 60-second intervals; passing checks alone do not mean the review is complete. Address every actionable issue, push the fixes, and repeat the review cycle until no actionable feedback remains. Do not merge while review bots are still pending or review issues remain unresolved.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
