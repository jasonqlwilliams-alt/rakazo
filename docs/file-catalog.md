# Optional file catalog and retrieval courier

This code is built and tested but **inactive**. Nothing registers the connector,
starts a watcher, or accesses a deployment. Activation needs a separate operator
decision and private configuration. No hosted service is required.

`FileCatalogConnector` in `packages/adapters/src/file-catalog.ts` implements the
existing `ConnectorProvider` boundary. `FileCatalogProvider` in
`packages/adapter-kit/src/file-catalog.ts` is the shared, provider-neutral contract.
An operator can later compose the connector with the existing connector stack.
There is no frontend integration: the same run tools would serve web, desktop,
and mobile. This adds no delegated-tool capability or unattended permission.

## Search and requests

The local adapter runs `packages/adapters/src/catalog/host.py` using Python 3.11+
and its standard library. This process belongs on the privileged host, never
inside a bot computer. Neither the catalog, parking root, undo log, signing key,
held records, nor audit log may be mounted into a seat or team computer.

- `catalog_search` accepts a literal filename substring, an optional cursor, and
  a limit from 1 to 25 (default 10). It returns only ID, basename, byte size and
  SHA-256, with an optional next cursor. No storage paths or file contents leave
  the host. Only hashed records under the requester's configured catalog roots
  appear. Search does not query filenames in the parking area.
- Search scans at most 5,000 row IDs per call, with a two-second SQLite execution
  budget. Pages can be empty and still have a continuation. Continue using the
  cursor with the same query; omit it to start a new search. There is no total
  count or unbounded listing operation. Names are capped at 160 UTF-8 bytes.
- SQLite is opened with `mode=ro&immutable=1` and `query_only`. Immutable mode
  reads the checkpointed database, not live WAL additions. The catalog owner
  must supply a stable, checkpointed catalog during use; this adapter never
  checkpoints, writes, or copies it. Unavailable or unhashed files are refused.
- `catalog_request` accepts only a returned file ID. It is declared a write, so
  the existing connector approval policy applies. The authenticated run supplies
  workspace, owner and bot identity; tool arguments cannot supply an identity,
  vault or destination. Requesting a file does not authorize copying it.

Submission publishes a complete Markdown packet atomically into the configured
router's `inbox/new/`. The envelope uses `type: continuum-packet`,
`schema: packet-router/v1`, `kind: file-retrieval`, `role_target: eleusis`,
`ask_of: eleusis`, normal priority, and a 48-hour TTL. `from` is the configured
requester role, never a bot UUID. The JSON body contains a signed request with
its packet ID, requester identity, principal key, file ID and creation time.
It contains no original path, parked path, destination or filename.
`read_only: true` describes router handling: hold and route, never execute a
copy from the packet itself. The gateway remains the only path to firstmate;
this code does not message seats, call a webhook, or reopen another inbox.

The router's existing watcher claims the packet. The gateway routes this kind
to firstmate for a held retrieval. That gateway handling must be arranged at
activation; no live router registry or watcher is modified by this change.

## Private host configuration

Supply a JSON file through `LocalFileCatalogProvider({ configPath, python? })`;
`python` defaults to `python3`. The same configuration is passed to the courier's
`--config` option. Locations must be absolute host-native paths. There are no
hardcoded drive mounts, entity names or deployment paths.

| Field | Meaning |
| --- | --- |
| `catalog` | Read-only SQLite catalog with the `files` columns `id`, `path`, `size_bytes`, `sha256`, `hash_status` |
| `undoLog` | Read-only CSV with `original_path`, `parked_path`, `sha256`, `size_bytes`; extra columns are allowed |
| `parkingRoot` | Host-native parking directory, readable only by the host adapter/courier |
| `parkingPathPrefix` | Optional catalog-OS prefix corresponding exactly to `parkingRoot`; needed when the CSV uses a different OS's paths |
| `routerRoot` | Router root containing the existing `inbox/new` and `inbox/claimed` directories |
| `heldRoot` | Separate firstmate-owned directory of verified held records, outside the router and all vaults |
| `auditLog` | Private, append-only JSONL file; its parent must already exist |
| `requestSigningKey` | Secret random hexadecimal signing key of at least 32 bytes, shared only by the privileged request adapter and courier |
| `personalRoot` | Captain's personal scope, required only if a personal principal exists |
| `principals` | Explicit allowlist of authenticated requester identities and their scopes |

Each principal has `key`, `spaceId`, `userId`, `botId`, `role`, `scope`, and
`catalogRoots`. `scope` is `entity` or `personal`. Entity principals also require
`vaultRoot`. A personal principal always uses `personalRoot`; it cannot select
an entity vault. Catalog roots use the catalog's OS path syntax, so the host
never guesses drive mappings. Keep principal keys and mappings stable while
requests are pending. Signed identities prevent reassigning a pending packet
to a different bot, owner or workspace.

Vaults must be disjoint from parking, each other, and privileged storage.
Multiple personal principals may share the one personal root. All root
junctions resolve from operator configuration; descendants never follow
symlinks. The configuration and private data must be host-owned and inaccessible
to seat processes. Entity seats must not have OS access to other vaults. Never
commit this configuration, signing keys, real catalog rows, receipts or audit
logs to the public repository. Generic path-free errors are the only host
errors returned to bots.

## Triggering the courier

The courier is a one-shot **firstmate host command**, not a bot tool, background
poller, or automatic router handler. After the gateway delivers a held packet,
firstmate independently verifies the authenticated requester provenance and
creates `<packet-id>.json` under `heldRoot` with exactly these fields:

```json
{
  "status": "held",
  "packetId": "pkt-retrieval-00000000000000000000000000000000",
  "packetSha256": "<SHA-256 of the exact claimed packet bytes>",
  "principal": "<configured principal key>"
}
```

This is an authorization record owned by firstmate. Do not create it from the
packet's `from`, signature, transport receipt, or claimed status alone. A
transport receipt does not authenticate the sender or approve retrieval.
The courier checks both this record and the HMAC signature, full requester
identity, packet ID, kind, target role and 48-hour expiry. It does not scan or
replay the packet backlog. Firstmate invokes it for exactly one held packet:

```sh
python3 -B packages/adapters/src/catalog/host.py --config '<private-config>' courier --packet-id '<packet-id>'
```

The command above is a dry-run. It checks the mapping, source hash, and existing
destination without creating a file or audit log. An approved operator adds
`--execute` to perform the copy. Execution requires POSIX descriptor-relative
file operations and `O_NOFOLLOW`; unsupported hosts fail closed. A Windows
installation can later use a separate POSIX courier host with configured path
prefix translation. No host translation is inferred from a drive letter.

The courier resolves the catalog row by ID, finds exactly one matching original
path in the undo CSV, and verifies that the CSV and catalog hashes and sizes
agree. Only files beneath the configured parking root can be read. It copies
into the requester's configured root using a generated `<file-id>-<basename>`
name. The request cannot choose a filename or subdirectory. It streams a bounded
number of bytes, verifies SHA-256 before and after copying, and syncs the result.
It never overwrites, moves or deletes a parked file or destination. An existing
file with the same hash yields `already-present`; a different hash is refused.
Directory symlinks, leaf symlinks and destination creation races are refused.

Each executed copy attempt appends and syncs one JSONL transaction containing
transaction ID, packet ID, requesting bot, principal, expected SHA-256, source,
destination, outcome and time. The audit sink is opened before copying and
locked across the transaction. A dry-run writes no transaction. Failures during
copy or verification append `refused`; partial destinations stay for operator
inspection and are never removed or overwritten automatically. A process or
machine crash can interrupt the copy or final audit append; re-run the same held
packet to verify an existing complete copy and log `already-present`, or refuse
a conflicting partial copy. Firstmate records the router disposition separately;
this command does not mark packets done, send messages, or delete held records.

These are deliberately reversible implementation choices: explicit per-packet
host invocation, independent held authorization, filename-only search with
row-window cursors, generated destination names, and POSIX execution. Activation
and any broader host support remain separate work.

## Offline validation

```sh
pnpm exec vitest run packages/adapters/src/file-catalog.test.ts
```

This runs connector contract tests, the real Python subprocess boundary, and
Python courier conformance scenarios. Fixtures are synthetic and created only
under the worktree's ignored `.tmp` directory. No deployment, PostgreSQL
connection, production catalog, router, parking directory or real vault is used.
