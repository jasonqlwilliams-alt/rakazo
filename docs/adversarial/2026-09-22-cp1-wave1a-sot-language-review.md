# Architectural review — CP1 Wave-1a Source of Truth path fence (redacted)

- Date: 2026-09-22
- Reviewer: judgment-plane adversarial seat (this run). Private SoT remains authoritative. This file is architectural review and analysis.
- Scope: evaluate and record the CP1 Wave-1a Source of Truth (SoT) path fence application across active agent seats. Private paths, machine identifiers, operator credentials, and private fleet object IDs remain in private vault records.
- Fences honored: no direct production mutations outside authorized RPC path, no live chat saves, no credential disclosure, clean redaction of personal and entity identifiers.

Stamps used: **SOUND** (reproduced or independently corroborated), **THIN** (plausible, unfalsified, insufficient artifact), **WRONG** (contradicted by evidence).

---

## 1. Context and problem analysis

### 1.1 The path blur defect

An architectural audit of applied seat system instructions identified an inaccurate path model teaching that the system rules repository was "the Obsidian vault Source of Truth". This conflated three separate layers:

1. **Rules and SOPs repository:** Contains procedural governance and operating SOPs, not personal vault state or live execution records.
2. **Personal knowledge vault:** Contains personal notes, briefs, creation receipts, and packet router queues, separate from system operational rules.
3. **Runtime environment:** The live application runtime and connected services, verified through health endpoints rather than static documentation files.

Teaching the rules repository as the universal source of truth created risk of circular authority drift and path errors during autonomous agent execution.

**Architectural Stamp: SOUND** (confirmed across live seat prompt audits and verified by architectural review).

---

## 2. Wave-1a apply disposition

The correction was executed strictly across the Wave-1a target seats via authenticated RPC (`POST /rpc/bots/update`), preserving the distinct separation between seat descriptions and personas:

### 2.1 Seat-specific resolution
- **Companion Seat:** Retained live text with no invented deletions. Injected the locked path fence once directly adjacent to runtime health resolution.
- **Adversarial / Quality Control Seat:** Replaced both the dedicated obsolete sentence and the operating-law clause with a single consolidated fence block. Preserved all adversarial friction, isolated worktree constraints, and quality control directives without voice softening.
- **Assurance / QA Seat:** Replaced the operating-law clause with a single fence block. Preserved the clearance-result gating and verification proof voice.
- **Catalog Seat:** Replaced the dedicated obsolete sentence and operating-law clause with a single fence block. Preserved the read-only catalog duty and financial safety boundaries.

### 2.2 Invariant verification
- Exactly four seats modified; remaining fleet seats held for subsequent waves.
- Fence block injected byte-identically with canonical typographic quotes (U+201C, U+201D).
- Zero residual obsolete path sentences across all four seats.
- Single fence block per seat (deduplication enforced).
- Live verification confirmed via read-after-write RPC and direct database query.

---

## 3. Structural remediation and next steps

- **Wave-1b staging:** The remaining fleet seats carrying the legacy operating-law clause remain held pending verification evidence acceptance.
- **Delivery verification:** Evidence package generated and verified under the packet router evidence register.
