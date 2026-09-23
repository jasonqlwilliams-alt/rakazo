# Architectural review — packet router conveyor drain & dispatch hub recovery (redacted)

- Date: 2026-09-22
- Reviewer: judgment-plane adversarial seat (this run). Private SoT remains authoritative. This file is architectural review and analysis.
- Scope: evaluate the packet router dead-letter conveyor failure mode, hub payment-block stall, and queue drain disposition. Private paths, machine identifiers, operator credentials, and private fleet object IDs remain in private vault records.
- Fences honored: no direct production mutations, no live chat saves, no credential disclosure, clean redaction of personal and entity identifiers.

Stamps used: **SOUND** (reproduced or independently corroborated), **THIN** (plausible, unfalsified, insufficient artifact), **WRONG** (contradicted by evidence).

---

## 1. Systemic failure mode analysis

### 1.1 The automated dead-letter conveyor

An investigation into the interaction between the host file watcher and the central dispatch bot revealed an asynchronous failure mode:

1. **Intake and Claim:**
   The host file watcher continuously monitors the inbound drop directory. When a packet arrives, it transitions the file to claimed status and invokes the central hub bot's webhook endpoint (`POST /api/v1/bots/:id/webhook`).
2. **Asynchronous Webhook Blind Spot:**
   The API acknowledges the inbound webhook with an immediate HTTP 200 after enqueuing the background run. The watcher logs a successful webhook trigger and yields.
3. **Execution Failure on Depleted Model Quota:**
   When the hub bot initiates its run, the upstream model invocation fails (HTTP 402 / credit exhaustion). The run transitions to failed status. Crucially, no failure notification or retry signal propagates back across the filesystem boundary.
4. **Silent TTL Expiry:**
   A periodic background sweep moves unserviced claimed files to the stale directory once their time-to-live threshold (e.g. 6 hours for high-priority alerts, 48 hours for standard notes) expires. The sweeper attempts to post a stale event to the same hub bot, which fails identically due to the underlying billing state.
5. **False-Healthy Illusion:**
   External monitoring observing only the intake queue sees zero pending items, masking the accumulation of dead packets in the stale graveyard.

**Architectural Stamp: SOUND** (reproduced across live run histories and queue transition logs).

---

## 2. Queue triage and drain disposition

An exhaustive review of accumulated packets was conducted to distinguish live obligations from resolved or superseded artifacts:

### 2.1 Stale packet resolution
- **Resolved / Superseded (90%):**
  - Verification pulses, test notifications, and environment restore pings whose targets had already been achieved or superseded by subsequent stable runs.
  - Research requests, registry updates, and system state cards whose deliverables were already generated and stamped in durable stores.
  - High-priority operational alerts that had already been surfaced to and settled by the operator out-of-band via interactive terminal sessions.
- **Unserviced Internal Tasks (10%):**
  - Internal bot-to-bot briefs (such as container mount redirects, roundtable authoring requests, and post-merge architectural co-reviews) that could not execute during the hub outage.
  - Held in place for operator and supervisor re-dispatch rather than silent disposal.

### 2.2 Claimed packet resolution
- In-flight research briefs, historical review requests, and delivered draft notifications were reconciled against current program artifacts and retired to historical completed records.
- Active emergency alerts requiring account owner intervention were verified as delivered to the notification bot and surfaced as active pending decision cards.

---

## 3. Structural remediation requirements

Merely draining accumulated files clears backpressure but does not eliminate the failure mode. Permanent system resilience requires:

1. **Out-of-band watchdog:**
   A standalone bypass monitor that scans the claimed queue for high-priority packets whose age exceeds a critical threshold (e.g. 15 minutes) without downstream confirmation, escalating directly through independent notification paths rather than the primary hub.
2. **Upstream billing & health telemetry:**
   Exposing model provider credit and error states directly on health endpoints to avoid silent execution dropouts.
3. **Deterministic dead-letter quarantine:**
   Transitioning expired urgent packets to an active emergency quarantine rather than a passive stale folder.
