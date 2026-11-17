"""Offline conformance tests. All writable fixtures stay under the task worktree."""
import hashlib
import importlib.util
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("catalog_host", Path(__file__).with_name("host.py"))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


@unittest.skipUnless(os.name == "posix", "Courier requires POSIX file fences")
class HostTest(unittest.TestCase):
    def setUp(self):
        temporary_root = Path.cwd() / ".tmp"
        temporary_root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temporary_root)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for directory in ("parking/objects", "vault-a", "vault-b", "personal", "router/inbox/new", "router/inbox/claimed", "held", "audit"):
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        self.data = b"synthetic document\n"
        self.sha = hashlib.sha256(self.data).hexdigest()
        (self.root / "parking/objects/blob").write_bytes(self.data)
        self.original = "/synthetic-documents/report.txt"
        self.config = {
            "catalog": str(self.root / "catalog.db"), "undoLog": str(self.root / "undo.csv"),
            "parkingRoot": str(self.root / "parking"), "routerRoot": str(self.root / "router"),
            "heldRoot": str(self.root / "held"), "auditLog": str(self.root / "audit/transactions.jsonl"),
            "personalRoot": str(self.root / "personal"), "requestSigningKey": "ab" * 32,
            "principals": [
                {"key": "seat-a", "spaceId": "space-a", "userId": "user-a", "botId": "bot-a", "role": "seat-a", "scope": "entity", "vaultRoot": str(self.root / "vault-a"), "catalogRoots": ["/synthetic-documents"]},
                {"key": "seat-b", "spaceId": "space-a", "userId": "user-a", "botId": "bot-b", "role": "seat-b", "scope": "entity", "vaultRoot": str(self.root / "vault-b"), "catalogRoots": ["/synthetic-documents"]},
                {"key": "personal", "spaceId": "space-a", "userId": "user-a", "botId": "bot-p", "role": "personal", "scope": "personal", "catalogRoots": ["/synthetic-documents"]},
            ],
        }
        self.principal = self.config["principals"][0]
        db = sqlite3.connect(self.config["catalog"])
        with db:
            db.execute("CREATE TABLE files(id INTEGER PRIMARY KEY,path TEXT,size_bytes INTEGER,sha256 TEXT,hash_status TEXT)")
            db.executemany("INSERT INTO files VALUES(?,?,?,?,?)", [
                (1, self.original, len(self.data), self.sha, "hashed"),
                (2, "/synthetic-documents/report-two.txt", 12, "cd" * 32, "hashed"),
                (3, "/other-documents/report-private.txt", 20, "ef" * 32, "hashed"),
                (4, "/synthetic-documents/report-pending.txt", 12, None, "pending"),
                (10001, "/synthetic-documents/report-later.txt", 12, self.sha, "hashed"),
            ])
        db.close()
        self.write_undo()
        host.validate_config(self.config)

    def write_undo(self, path=None, sha=None):
        import csv
        with open(self.config["undoLog"], "w", newline="") as output:
            writer = csv.DictWriter(output, fieldnames=["original_path", "parked_path", "sha256", "size_bytes"])
            writer.writeheader()
            writer.writerow({"original_path": self.original, "parked_path": str(path or self.root / "parking/objects/blob"), "sha256": sha or self.sha, "size_bytes": len(self.data)})

    def held(self, principal=None):
        packet_id, packet = host.render_packet(self.config, principal or self.principal, "1")
        (self.root / "router/inbox/claimed" / (packet_id + ".md")).write_bytes(packet)
        return packet_id

    def audit(self):
        return [json.loads(line) for line in Path(self.config["auditLog"]).read_text().splitlines()]

    def test_search_compact_scoped_and_paginated_without_mutation(self):
        before = Path(self.config["catalog"]).read_bytes()
        page = host.search(self.config, self.principal, {"query": "report", "limit": 1})
        self.assertEqual(page["files"], [{"id": "1", "name": "report.txt", "bytes": len(self.data), "sha256": self.sha}])
        page = host.search(self.config, self.principal, {"query": "report", "limit": 1, "cursor": page["nextCursor"]})
        self.assertEqual([f["id"] for f in page["files"]], ["2"])
        page = host.search(self.config, self.principal, {"query": "report", "cursor": page["nextCursor"]})
        self.assertEqual([f["id"] for f in page["files"]], ["10001"])
        self.assertNotIn("nextCursor", page)
        self.assertEqual(Path(self.config["catalog"]).read_bytes(), before)
        self.assertFalse(Path(self.config["catalog"] + "-wal").exists())

    def test_sparse_large_ids_keep_a_valid_cursor(self):
        sparse_id = 1000000000000000000
        db = sqlite3.connect(self.config["catalog"])
        with db:
            db.execute("INSERT INTO files VALUES(?,?,?,?,'hashed')",
                       (sparse_id, "/synthetic-documents/sparse-report.txt", len(self.data), self.sha))
            db.execute("INSERT INTO files VALUES(?,?,?,?,'hashed')",
                       (sparse_id + 1, "/synthetic-documents/sparse-report-later.txt", len(self.data), self.sha))
        db.close()
        page = host.search(self.config, self.principal, {"query": "sparse-report", "limit": 1})
        self.assertEqual([item["id"] for item in page["files"]], [str(sparse_id)])
        self.assertEqual(page["nextCursor"], str(sparse_id))
        page = host.search(self.config, self.principal,
                           {"query": "sparse-report", "limit": 1, "cursor": page["nextCursor"]})
        self.assertEqual([item["id"] for item in page["files"]], [str(sparse_id + 1)])
        self.assertNotIn("nextCursor", page)
        _, packet = host.render_packet(self.config, self.principal, str(sparse_id))
        self.assertEqual(host.parse_packet(self.config, self.principal, packet)["fileId"], str(sparse_id))

    def test_search_scan_limit_returns_progress_and_reaches_later_match(self):
        db = sqlite3.connect(self.config["catalog"])
        with db:
            db.executemany("INSERT INTO files VALUES(?,?,?,?,?)",
                           ((id, f"/synthetic-documents/other-{id}.txt", 1, self.sha, "hashed")
                            for id in range(5, 5007)))
            db.execute("UPDATE files SET path=? WHERE id=20", ("/synthetic-documents/target-early.txt",))
            db.execute("INSERT INTO files VALUES(5007,?,?,?,'hashed')",
                       ("/synthetic-documents/target.txt", len(self.data), self.sha))
        db.close()
        page = host.search(self.config, self.principal, {"query": "target.txt"})
        self.assertEqual(page, {"files": [], "nextCursor": "5000", "scanTruncated": True})
        page = host.search(self.config, self.principal, {"query": "target.txt", "cursor": page["nextCursor"]})
        self.assertEqual([item["id"] for item in page["files"]], ["5007"])
        self.assertNotIn("nextCursor", page)
        self.assertNotIn("scanTruncated", page)
        page = host.search(self.config, self.principal, {"query": "target"})
        self.assertEqual([item["id"] for item in page["files"]], ["20"])
        self.assertEqual(page["nextCursor"], "5000")
        self.assertTrue(page["scanTruncated"])

    def test_broad_visibility_never_lists_parking(self):
        self.principal["catalogRoots"] = ["/"]
        db = sqlite3.connect(self.config["catalog"])
        with db:
            db.execute("INSERT INTO files VALUES(5,?,?,?,'hashed')", (str(self.root / "parking/hidden.txt"), 1, self.sha))
        db.close()
        self.assertEqual(host.search(self.config, self.principal, {"query": "hidden"})["files"], [])
        with self.assertRaises(host.Refused):
            host.file_record(self.config, self.principal, "5")

    def test_search_literal_query_and_limits(self):
        self.assertEqual(host.search(self.config, self.principal, {"query": "%"})["files"], [])
        for args in ({"query": ""}, {"query": "x", "limit": 26}, {"query": "x", "limit": True}, {"query": "x", "cursor": "-1"}, {"query": "x", "path": "/"}):
            with self.subTest(args=args), self.assertRaises(host.Refused):
                host.search(self.config, self.principal, args)
        with self.assertRaises(sqlite3.OperationalError), host.catalog(self.config) as db:
            db.execute("DELETE FROM files")

    def test_submission_role_packet_contains_no_host_paths(self):
        result = host.submit(self.config, self.principal, {"fileId": "1"})
        packet = (self.root / "router/inbox/new" / (result["packetId"] + ".md")).read_bytes()
        parsed = host.parse_packet(self.config, self.principal, packet)
        self.assertEqual(parsed["fileId"], "1")
        self.assertEqual(parsed["sha256"], self.sha)
        self.assertNotIn(str(self.root), packet.decode())
        self.assertNotIn(self.original, packet.decode())
        self.assertIn('role_target: "eleusis"', packet.decode())
        with self.assertRaises(host.Refused):
            host.submit(self.config, self.principal, {"fileId": "3"})
        with self.assertRaises(host.Refused):
            host.submit(self.config, self.principal, {"fileId": "1", "principal": "seat-b"})

    def test_catalog_change_cannot_substitute_requested_hash(self):
        packet_id = self.held()
        db = sqlite3.connect(self.config["catalog"])
        with db:
            db.execute("UPDATE files SET sha256=? WHERE id=1", ("cd" * 32,))
        db.close()
        with self.assertRaises(host.Refused):
            host.courier(self.config, packet_id)
        with self.assertRaises(host.Refused):
            host.courier(self.config, packet_id, True)
        self.assertEqual(list((self.root / "vault-a").iterdir()), [])
        self.assertEqual(self.audit(), [])

    def test_dry_run_leaves_all_directories_unwritten(self):
        packet_id = self.held()
        before = sorted(p.relative_to(self.root) for p in self.root.rglob("*"))
        self.assertEqual(host.courier(self.config, packet_id)["status"], "dry-run")
        self.assertEqual(sorted(p.relative_to(self.root) for p in self.root.rglob("*")), before)

    def test_claimed_packet_becomes_held_only_on_execution(self):
        packet_id = self.held()
        held_path = self.root / "held" / (packet_id + ".json")
        self.assertFalse(held_path.exists())
        self.assertEqual(host.courier(self.config, packet_id)["status"], "dry-run")
        self.assertFalse(held_path.exists())
        self.assertEqual(host.courier(self.config, packet_id, True)["status"], "copied")
        self.assertEqual(json.loads(held_path.read_text())["principal"], "seat-a")
        self.assertEqual((self.root / "vault-a/1-report.txt").read_bytes(), self.data)

    def test_copy_hash_audit_and_idempotent_retry(self):
        packet_id = self.held()
        self.assertEqual(host.courier(self.config, packet_id, True)["status"], "copied")
        self.assertEqual((self.root / "vault-a/1-report.txt").read_bytes(), self.data)
        self.assertEqual((self.root / "parking/objects/blob").read_bytes(), self.data)
        self.assertEqual(list((self.root / "vault-b").iterdir()), [])
        self.assertEqual(host.courier(self.config, packet_id, True)["status"], "already-present")
        records = self.audit()
        self.assertEqual([(r["phase"], r.get("status")) for r in records], [
            ("intent", None), ("outcome", "copied"),
            ("intent", None), ("outcome", "already-present"),
        ])
        self.assertEqual(records[0]["sha256"], self.sha)
        self.assertEqual(records[0]["requestingBot"], "bot-a")
        self.assertEqual(records[0]["source"], str(self.root / "parking/objects/blob"))
        self.assertEqual(records[0]["destination"], str(self.root / "vault-a/1-report.txt"))

    def test_personal_request_uses_personal_scope(self):
        packet_id = self.held(self.config["principals"][2])
        host.courier(self.config, packet_id, True)
        self.assertEqual((self.root / "personal/1-report.txt").read_bytes(), self.data)
        self.assertEqual(list((self.root / "vault-a").iterdir()), [])

    def test_conflict_never_overwrites_and_logs_refusal(self):
        packet_id = self.held()
        destination = self.root / "vault-a/1-report.txt"
        destination.write_bytes(b"other content")
        with self.assertRaises(host.Refused):
            host.courier(self.config, packet_id, True)
        self.assertEqual(destination.read_bytes(), b"other content")
        self.assertEqual(self.audit()[-1]["status"], "refused")

    def test_source_and_mapping_hash_mismatch(self):
        packet_id = self.held()
        self.write_undo(sha="00" * 32)
        with self.assertRaises(host.Refused):
            host.courier(self.config, packet_id, True)
        self.write_undo()
        (self.root / "parking/objects/blob").write_bytes(b"changed source")
        with self.assertRaises(host.Refused):
            host.courier(self.config, packet_id, True)
        self.assertEqual(list((self.root / "vault-a").iterdir()), [])

    def test_tampered_packet_or_claimed_identity_refused(self):
        packet_id = self.held()
        host.held_packet(self.config, packet_id, True)
        held_path = self.root / "held" / (packet_id + ".json")
        record = json.loads(held_path.read_text())
        record["principal"] = "seat-b"
        held_path.write_text(json.dumps(record))
        with self.assertRaises(host.Refused):
            host.courier(self.config, packet_id, True)
        record["principal"] = "seat-a"
        packet_path = self.root / "router/inbox/claimed" / (packet_id + ".md")
        content = packet_path.read_bytes().replace(b'"fileId":"1"', b'"fileId":"2"')
        packet_path.write_bytes(content)
        record["packetSha256"] = host.digest(content)
        held_path.write_text(json.dumps(record))
        with self.assertRaises(host.Refused):
            host.courier(self.config, packet_id, True)

    def test_expired_or_unheld_packet_refused(self):
        packet_id = self.held()
        host.held_packet(self.config, packet_id, True)
        held_path = self.root / "held" / (packet_id + ".json")
        held = json.loads(held_path.read_text())
        held["status"] = "new"
        held_path.write_text(json.dumps(held))
        with self.assertRaises(host.Refused):
            host.courier(self.config, packet_id, True)
        _, content = host.render_packet(self.config, self.principal, "1")
        packet = host.parse_packet(self.config, self.principal, content)
        packet["createdAt"] = "2000-01-01T00:00:00+00:00"
        old_body = json.loads(re.findall(r"```json\n([^`]+)\n```", content.decode())[0])
        new_body = {"request": packet, "signature": host.signature(self.config, packet)}
        expired = content.replace(host.canonical(old_body), host.canonical(new_body))
        with self.assertRaises(host.Refused):
            host.parse_packet(self.config, self.principal, expired)

    def test_outside_parking_and_symlinks_refused(self):
        packet_id = self.held()
        self.write_undo(path=self.root / "personal/secret")
        with self.assertRaises(host.Refused):
            host.courier(self.config, packet_id, True)
        self.write_undo()
        original = self.root / "parking/objects/blob"
        original.unlink()
        original.symlink_to(self.root / "undo.csv")
        with self.assertRaises(OSError):
            host.courier(self.config, packet_id, True)
        self.assertEqual(list((self.root / "vault-a").iterdir()), [])

    def test_destination_symlink_and_create_race(self):
        packet_id = self.held()
        destination = self.root / "vault-a/1-report.txt"
        destination.symlink_to(self.root / "undo.csv")
        with self.assertRaises(OSError):
            host.courier(self.config, packet_id, True)
        destination.unlink()
        original_open = os.open
        def racing_open(path, flags, *args, **kwargs):
            if path == destination.name and flags & os.O_CREAT:
                destination.write_bytes(b"race winner")
            return original_open(path, flags, *args, **kwargs)
        with patch.object(host.os, "open", side_effect=racing_open), self.assertRaises(FileExistsError):
            host.courier(self.config, packet_id, True)
        self.assertEqual(destination.read_bytes(), b"race winner")
        self.assertEqual(self.audit()[-1]["status"], "refused")

    def test_directory_symlink_and_missing_audit_prevent_copy(self):
        packet_id = self.held()
        objects = self.root / "parking/objects"
        (objects / "blob").unlink()
        objects.rmdir()
        objects.symlink_to(self.root / "personal", target_is_directory=True)
        with self.assertRaises(OSError):
            host.courier(self.config, packet_id, True)
        self.assertEqual(list((self.root / "vault-a").iterdir()), [])
        objects.unlink()
        objects.mkdir()
        (objects / "blob").write_bytes(self.data)
        self.config["auditLog"] = str(self.root / "missing/audit.jsonl")
        with self.assertRaises(OSError):
            host.courier(self.config, packet_id, True)
        self.assertEqual(list((self.root / "vault-a").iterdir()), [])

    def test_post_copy_verification_failure_is_logged(self):
        packet_id = self.held()
        original_hash = host.file_hash
        def corrupt_hash(handle):
            if handle.mode != "rb":
                handle.seek(0)
                handle.write(b"corrupt")
                handle.flush()
            return original_hash(handle)
        with patch.object(host, "file_hash", side_effect=corrupt_hash), self.assertRaises(host.Refused):
            host.courier(self.config, packet_id, True)
        self.assertEqual(self.audit()[-1]["status"], "refused")
        self.assertTrue((self.root / "vault-a/1-report.txt").exists())

    def test_unfinished_intent_reconciles_destination_hash(self):
        packet_id = self.held()
        record = {"transactionId": "synthetic-intent", "packetId": packet_id, "fileId": "1",
                  "requestingBot": "bot-a", "principal": "seat-a", "sha256": self.sha,
                  "source": str(self.root / "parking/objects/blob"),
                  "destination": str(self.root / "vault-a/1-report.txt"), "phase": "intent"}
        Path(self.config["auditLog"]).write_text(json.dumps(record) + "\n")
        (self.root / "vault-a/1-report.txt").write_bytes(self.data)
        self.assertEqual(host.courier(self.config, packet_id, True)["status"], "already-present")
        self.assertEqual([(r["phase"], r.get("status")) for r in self.audit()],
                         [("intent", None), ("outcome", "reconciled")])
        self.assertEqual(self.audit()[-1]["transactionId"], "synthetic-intent")
        (self.root / "vault-a/1-report.txt").unlink()
        packet_id = self.held()
        record["packetId"] = packet_id
        record["transactionId"] = "synthetic-missing"
        Path(self.config["auditLog"]).write_text(json.dumps(record) + "\n")
        self.assertEqual(host.courier(self.config, packet_id, True)["status"], "copied")
        self.assertEqual([(r["phase"], r.get("status")) for r in self.audit()],
                         [("intent", None), ("outcome", "interrupted"),
                          ("intent", None), ("outcome", "copied")])

    def test_recovery_uses_intent_after_catalog_refresh(self):
        packet_id = self.held()
        record = {"transactionId": "synthetic-intent", "packetId": packet_id, "fileId": "1",
                  "requestingBot": "bot-a", "principal": "seat-a", "sha256": self.sha,
                  "source": str(self.root / "parking/objects/blob"),
                  "destination": str(self.root / "vault-a/1-report.txt"), "phase": "intent"}
        Path(self.config["auditLog"]).write_text(json.dumps(record) + "\n")
        (self.root / "vault-a/1-report.txt").write_bytes(self.data)
        db = sqlite3.connect(self.config["catalog"])
        with db:
            db.execute("DELETE FROM files WHERE id=1")
        db.close()
        Path(self.config["undoLog"]).unlink()
        self.assertEqual(host.courier(self.config, packet_id, True)["status"], "already-present")
        self.assertEqual(self.audit()[-1]["status"], "reconciled")
        self.assertEqual((self.root / "vault-a/1-report.txt").read_bytes(), self.data)

    def test_recovery_fences_recorded_destination_and_requester(self):
        packet_id = self.held()
        record = {"transactionId": "synthetic-intent", "packetId": packet_id, "fileId": "1",
                  "requestingBot": "bot-a", "principal": "seat-a", "sha256": self.sha,
                  "source": str(self.root / "parking/objects/blob"),
                  "destination": str(self.root / "vault-b/1-report.txt"), "phase": "intent"}
        Path(self.config["auditLog"]).write_text(json.dumps(record) + "\n")
        (self.root / "vault-b/1-report.txt").write_bytes(self.data)
        with self.assertRaises(host.Refused):
            host.courier(self.config, packet_id, True)
        record["destination"] = str(self.root / "vault-a/1-report.txt")
        record["requestingBot"] = "bot-b"
        Path(self.config["auditLog"]).write_text(json.dumps(record) + "\n")
        with self.assertRaises(host.Refused):
            host.courier(self.config, packet_id, True)
        record["requestingBot"] = "bot-a"
        record["sha256"] = "cd" * 32
        Path(self.config["auditLog"]).write_text(json.dumps(record) + "\n")
        with self.assertRaises(host.Refused):
            host.courier(self.config, packet_id, True)
        self.assertEqual(list((self.root / "vault-a").iterdir()), [])
        self.assertEqual((self.root / "vault-b/1-report.txt").read_bytes(), self.data)

    def test_partial_outcome_is_reconciled(self):
        packet_id = self.held()
        record = {"transactionId": "synthetic-intent", "packetId": packet_id, "fileId": "1",
                  "requestingBot": "bot-a", "principal": "seat-a", "sha256": self.sha,
                  "source": str(self.root / "parking/objects/blob"),
                  "destination": str(self.root / "vault-a/1-report.txt"), "phase": "intent"}
        Path(self.config["auditLog"]).write_text(json.dumps(record) + "\n" + '{"phase":"out')
        (self.root / "vault-a/1-report.txt").write_bytes(self.data)
        self.assertEqual(host.courier(self.config, packet_id, True)["status"], "already-present")
        self.assertEqual(self.audit()[-1]["status"], "reconciled")

    def test_expired_request_only_closes_existing_intents(self):
        completed, missing, untouched = (self.held() for _ in range(3))
        for packet_id in (completed, missing, untouched):
            host.held_packet(self.config, packet_id, True)
        records = []
        for packet_id in (completed, missing):
            records.append({"transactionId": packet_id, "packetId": packet_id, "fileId": "1",
                            "requestingBot": "bot-a", "principal": "seat-a", "sha256": self.sha,
                            "source": str(self.root / "parking/objects/blob"),
                            "destination": str(self.root / "vault-a/1-report.txt"), "phase": "intent"})
        Path(self.config["auditLog"]).write_text("".join(json.dumps(record) + "\n" for record in records))
        destination = self.root / "vault-a/1-report.txt"
        destination.write_bytes(self.data)

        class ExpiredClock(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime.now(tz) + timedelta(hours=49)

        with patch.object(host, "datetime", ExpiredClock):
            self.assertEqual(host.courier(self.config, completed, True)["status"], "already-present")
            destination.unlink()
            with self.assertRaises(host.Refused):
                host.courier(self.config, missing, True)
            with self.assertRaises(host.Refused):
                host.courier(self.config, untouched, True)
        self.assertFalse(destination.exists())
        self.assertEqual([(r["phase"], r.get("status")) for r in self.audit() if r["packetId"] == completed],
                         [("intent", None), ("outcome", "reconciled")])
        self.assertEqual([(r["phase"], r.get("status")) for r in self.audit() if r["packetId"] == missing],
                         [("intent", None), ("outcome", "interrupted")])
        self.assertEqual([r["phase"] for r in self.audit() if r["packetId"] == untouched], [])

    def test_intent_is_durable_before_copy(self):
        packet_id = self.held()
        actual_transfer = host.transfer

        def inspect_then_transfer(*args):
            entries = self.audit()
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]["phase"], "intent")
            self.assertEqual(entries[0]["packetId"], packet_id)
            self.assertEqual(entries[0]["requestingBot"], "bot-a")
            self.assertFalse((self.root / "vault-a/1-report.txt").exists())
            return actual_transfer(*args)

        with patch.object(host, "transfer", side_effect=inspect_then_transfer):
            self.assertEqual(host.courier(self.config, packet_id, True)["status"], "copied")

    def test_cli_defaults_dry_run_and_scrubs_errors(self):
        packet_id = self.held()
        config_path = self.root / "host-config.json"
        config_path.write_text(json.dumps(self.config))
        command = [sys.executable, "-B", str(Path(host.__file__)), "--config", str(config_path)]
        result = subprocess.run(command + ["courier", "--packet-id", packet_id], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["status"], "dry-run")
        self.assertEqual(list((self.root / "vault-a").iterdir()), [])
        self.assertFalse(Path(self.config["auditLog"]).exists())
        result = subprocess.run(command + ["search"], input=json.dumps({"identity": {"spaceId": "other", "userId": "user-a", "botId": "bot-a"}, "args": {"query": "report"}}), capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {"error": "Catalog operation refused"})
        self.assertEqual(result.stderr, "")
        self.assertNotIn(str(self.root), result.stdout)
        self.assertNotIn(self.config["requestSigningKey"], result.stdout)

    def test_catalog_os_prefix_maps_without_exposing_storage(self):
        # Synthetic catalog OS differs from this host; the mapping is configured, never inferred.
        prefix = chr(90) + ":" + chr(92) + "synthetic-parking"
        self.config["parkingPathPrefix"] = prefix
        self.write_undo(path=prefix + chr(92) + "objects" + chr(92) + "blob")
        packet_id = self.held()
        self.assertEqual(host.courier(self.config, packet_id, True)["status"], "copied")
        self.assertEqual((self.root / "vault-a/1-report.txt").read_bytes(), self.data)

    def test_request_identity_cannot_be_remapped_after_signing(self):
        packet_id = self.held()
        self.principal["botId"] = "replacement-bot"
        with self.assertRaises(host.Refused):
            host.courier(self.config, packet_id, True)

    def test_identity_workspace_and_configuration_fences(self):
        with self.assertRaises(host.Refused):
            host.principal_for(self.config, {"spaceId": "other", "userId": "user-a", "botId": "bot-a"})
        self.config["principals"][1]["vaultRoot"] = str(self.root / "vault-a/nested")
        with self.assertRaises(host.Refused):
            host.validate_config(self.config)

    def test_parking_cannot_overlap_router_inbox(self):
        original = self.config["parkingRoot"]
        for path in (self.root / "router/inbox/new", self.root / "router"):
            self.config["parkingRoot"] = str(path)
            with self.assertRaises(host.Refused):
                host.validate_config(self.config)
        alias = self.root / "inbox-alias"
        alias.symlink_to(self.root / "router/inbox/claimed", target_is_directory=True)
        self.config["parkingRoot"] = str(alias)
        with self.assertRaises(host.Refused):
            host.validate_config(self.config)
        self.config["parkingRoot"] = original
        self.assertIs(host.validate_config(self.config), self.config)

    def test_router_inbox_child_aliases_cannot_expose_parking(self):
        for child, target in (("new", self.root / "parking"),
                              ("claimed", self.root / "parking/objects")):
            path = self.root / "router/inbox" / child
            path.rmdir()
            path.symlink_to(target, target_is_directory=True)
            with self.subTest(child=child), self.assertRaises(host.Refused):
                host.validate_config(self.config)
            path.unlink()
            path.mkdir()
            self.assertIs(host.validate_config(self.config), self.config)
        alias = self.root / "router-alias"
        alias.symlink_to(self.root / "router", target_is_directory=True)
        self.config["routerRoot"] = str(alias)
        self.assertIs(host.validate_config(self.config), self.config)


if __name__ == "__main__":
    unittest.main()
