"""Optional privileged file-catalog host. Python standard library; never import in a seat."""
from __future__ import annotations

import argparse
import csv
import hashlib
import hmac
import json
import os
import re
import sqlite3
import stat
import sys
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath


class Refused(Exception):
    """Deliberately path-free error safe to return to a bot."""


def require(condition, message="Catalog request refused"):
    if not condition:
        raise Refused(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def valid_id(value):
    return isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{0,14}", value) is not None


def original_parts(value):
    # Catalog paths may use a different OS from the courier host.
    path = PureWindowsPath(value) if "\\" in value or re.match(r"^[A-Za-z]:", value) else Path(value)
    require(path.is_absolute() and ".." not in path.parts)
    return path


def visible(path, principal, config):
    candidate = original_parts(path)
    parking = original_parts(config.get("parkingPathPrefix", config["parkingRoot"]))
    if candidate.is_relative_to(parking):
        return False
    return any(candidate.is_relative_to(original_parts(root)) for root in principal["catalogRoots"])


def principal_for(config, identity):
    matches = [p for p in config["principals"] if all(p[k] == identity[k] for k in ("spaceId", "userId", "botId"))]
    require(len(matches) == 1, "Catalog unavailable")
    return matches[0]


def validate_config(config):
    require(isinstance(config, dict))
    key = config.get("requestSigningKey", "")
    require(isinstance(key, str) and re.fullmatch(r"[0-9a-f]{64,}", key) is not None)
    principals = config.get("principals", [])
    require(isinstance(principals, list) and len(principals) > 0)
    identities, keys = set(), set()
    for p in principals:
        identity = tuple(p.get(k) for k in ("spaceId", "userId", "botId"))
        require(all(isinstance(v, str) and v for v in identity))
        require(identity not in identities and p.get("key") not in keys)
        identities.add(identity)
        keys.add(p.get("key"))
        require(isinstance(p.get("key"), str) and re.fullmatch(r"[a-z0-9-]{1,80}", p["key"]))
        require(isinstance(p.get("role"), str) and re.fullmatch(r"[a-z0-9-]{1,80}", p["role"]))
        require(p.get("scope") in ("entity", "personal"))
        require(isinstance(p.get("catalogRoots"), list) and p["catalogRoots"])
        for root in p["catalogRoots"]:
            original_parts(root)
        require(Path(destination_root(config, p)).is_absolute())
    for field in ("catalog", "undoLog", "parkingRoot", "routerRoot", "heldRoot", "auditLog"):
        require(isinstance(config.get(field), str) and Path(config[field]).is_absolute())
    # Roots are operator-owned. Resolve root junctions once, refuse overlapping vaults.
    destinations = [Path(destination_root(config, p)).resolve() for p in principals]
    parking = Path(config["parkingRoot"]).resolve()
    for i, root in enumerate(destinations):
        require(not root.is_relative_to(parking) and not parking.is_relative_to(root))
        for j, other in enumerate(destinations[:i]):
            if root == other:
                require(principals[i]["scope"] == principals[j]["scope"] == "personal")
            else:
                require(not root.is_relative_to(other) and not other.is_relative_to(root))
    protected = [Path(config[field]).resolve() for field in ("catalog", "undoLog", "heldRoot", "auditLog", "routerRoot")]
    for root in destinations:
        for path in protected:
            require(not path.is_relative_to(root) and not root.is_relative_to(path))
    held = Path(config["heldRoot"]).resolve()
    router = Path(config["routerRoot"]).resolve()
    require(not held.is_relative_to(router) and not router.is_relative_to(held))
    inbox = (router / "inbox").resolve()
    require(not parking.is_relative_to(inbox) and not inbox.is_relative_to(parking))
    return config


def destination_root(config, principal):
    return config["personalRoot"] if principal["scope"] == "personal" else principal["vaultRoot"]


@contextmanager
def catalog(config):
    uri = Path(config["catalog"]).as_uri() + "?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    deadline = time.monotonic() + 2
    connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
    try:
        yield connection
    finally:
        connection.close()


def file_record(config, principal, file_id):
    require(valid_id(file_id))
    with catalog(config) as connection:
        row = connection.execute("SELECT id,path,size_bytes,sha256,hash_status FROM files WHERE id=?", (int(file_id),)).fetchone()
    require(row is not None and visible(row["path"], principal, config), "File unavailable")
    require(row["hash_status"] == "hashed" and isinstance(row["sha256"], str) and re.fullmatch(r"[0-9a-fA-F]{64}", row["sha256"]), "File unavailable")
    require(type(row["size_bytes"]) is int and row["size_bytes"] >= 0, "File unavailable")
    return row


def search(config, principal, args):
    require(isinstance(args, dict) and set(args) <= {"query", "limit", "cursor"})
    query, limit, cursor = args.get("query"), args.get("limit", 10), args.get("cursor", "0")
    require(isinstance(query, str) and 1 <= len(query.strip()) <= 120)
    require(type(limit) is int and 1 <= limit <= 25)
    require(isinstance(cursor, str) and re.fullmatch(r"0|[1-9][0-9]{0,14}", cursor))
    # Scan a fixed row-id window, not an unbounded path LIKE over a multi-GB DB.
    # A page may be empty with a continuation; visibility filtering happens before output.
    after, window = int(cursor), 5000
    with catalog(config) as connection:
        rows = connection.execute(
            "SELECT id,path,size_bytes,sha256 FROM files WHERE id>? AND id<=? "
            "AND hash_status='hashed' AND sha256 IS NOT NULL ORDER BY id LIMIT ?",
            (after, after + window, window),
        )
        files, last = [], after + window
        for row in rows:
            if not visible(row["path"], principal, config):
                continue
            name = original_parts(row["path"]).name
            if query.strip().casefold() not in name.casefold():
                continue
            if not re.fullmatch(r"[0-9a-fA-F]{64}", row["sha256"]) or type(row["size_bytes"]) is not int or row["size_bytes"] < 0:
                continue
            files.append({"id": str(row["id"]), "name": name.encode("utf-8")[:160].decode("utf-8", errors="ignore"), "bytes": row["size_bytes"], "sha256": row["sha256"].lower()})
            if len(files) == limit:
                last = row["id"]
                break
        more = connection.execute("SELECT 1 FROM files WHERE id>? LIMIT 1", (last,)).fetchone() is not None
    return {"files": files, **({"nextCursor": str(last)} if more else {})}


def signature(config, payload):
    return hmac.new(bytes.fromhex(config["requestSigningKey"]), canonical(payload), hashlib.sha256).hexdigest()


def render_packet(config, principal, file_id):
    file_record(config, principal, file_id)
    packet_id = "pkt-retrieval-" + uuid.uuid4().hex
    payload = {"version": 1, "packetId": packet_id, "principal": principal["key"], "fileId": file_id,
               "identity": {k: principal[k] for k in ("spaceId", "userId", "botId")},
               "createdAt": datetime.now(timezone.utc).isoformat()}
    envelope = {"type": "continuum-packet", "schema": "packet-router/v1", "kind": "file-retrieval",
                "id": packet_id, "from": principal["role"], "cli": "rakazo-catalog", "role_target": "eleusis",
                "ask_of": "eleusis", "priority": "normal", "created_at_pt": payload["createdAt"], "ttl_hours": 48,
                "status": "new", "read_only": True, "continuum_paths": [], "non_goals": ["direct parking access"]}
    # JSON scalars are YAML-compatible; the parser accepts exactly our envelope subset.
    header = "\n".join(f"{k}: {json.dumps(v)}" for k, v in envelope.items())
    body = {"request": payload, "signature": signature(config, payload)}
    packet = f"---\n{header}\n---\n\n# Intent\n\nRequest a held file retrieval.\n\n# Ask\n\nRoute to the firstmate courier; hold for trusted requester verification.\n\n```json\n{canonical(body).decode()}\n```\n"
    return packet_id, packet.encode("utf-8")


@contextmanager
def directory(root):
    # Pin operator-configured root; no descendant supplied by a model may be followed.
    require(os.name == "posix" and hasattr(os, "O_NOFOLLOW"), "Courier host requires POSIX file fences")
    fd = os.open(Path(root).resolve(strict=True), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        yield fd
    finally:
        os.close(fd)


@contextmanager
def descendant(root, relative):
    parts = Path(relative).parts
    require(parts and not Path(relative).is_absolute() and all(x not in (".", "..") for x in parts))
    with directory(root) as fd:
        opened = []
        try:
            for part in parts[:-1]:
                fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                opened.append(fd)
            yield fd, parts[-1]
        finally:
            for child in reversed(opened):
                os.close(child)


def submit(config, principal, args):
    require(isinstance(args, dict) and set(args) == {"fileId"})
    packet_id, content = render_packet(config, principal, args["fileId"])
    # Publish complete packets atomically; the watcher never sees a partial Markdown file.
    staging = packet_id + ".pending"
    with directory(config["routerRoot"]) as root, descendant(config["routerRoot"], "inbox/new/" + packet_id + ".md") as (parent, name):
        fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root)
        try:
            with os.fdopen(fd, "wb") as target:
                target.write(content)
                target.flush()
                os.fsync(target.fileno())
            os.link(staging, name, src_dir_fd=root, dst_dir_fd=parent, follow_symlinks=False)
            os.fsync(parent)
        finally:
            os.unlink(staging, dir_fd=root)
            os.fsync(root)
    return {"packetId": packet_id}


def read_relative(root, relative, maximum=65536):
    with descendant(root, relative) as (parent, name):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, "rb") as source:
            require(stat.S_ISREG(os.fstat(source.fileno()).st_mode))
            data = source.read(maximum + 1)
            require(len(data) <= maximum)
            return data


def parse_packet(config, principal, content, allow_expired=False):
    text = content.decode("utf-8")
    sections = text.split("\n---\n", 1)
    require(len(sections) == 2 and sections[0].startswith("---\n"))
    header = {}
    for line in sections[0][4:].splitlines():
        key, value = line.split(":", 1)
        require(key not in header)
        header[key] = json.loads(value)
    require(header.get("type") == "continuum-packet" and header.get("schema") == "packet-router/v1")
    require(header.get("kind") == "file-retrieval" and header.get("role_target") == header.get("ask_of") == "eleusis")
    require(header.get("from") == principal["role"])
    blocks = re.findall(r"```json\n([^`]+)\n```", sections[1])
    require(len(blocks) == 1)
    body = json.loads(blocks[0])
    require(set(body) == {"request", "signature"} and isinstance(body["signature"], str))
    payload = body["request"]
    require(set(payload) == {"version", "packetId", "principal", "fileId", "identity", "createdAt"})
    require(hmac.compare_digest(body["signature"], signature(config, payload)))
    require(payload["version"] == 1 and payload["principal"] == principal["key"])
    require(payload["identity"] == {k: principal[k] for k in ("spaceId", "userId", "botId")})
    require(header.get("id") == payload["packetId"])
    created = datetime.fromisoformat(payload["createdAt"])
    require(created.tzinfo is not None)
    age = (datetime.now(timezone.utc) - created).total_seconds()
    require(0 <= age and (allow_expired or age <= 48 * 3600))
    return payload


def parked_record(config, row):
    found = None
    with open(config["undoLog"], newline="", encoding="utf-8-sig") as source:
        for entry in csv.DictReader(source):
            if original_parts(entry["original_path"]) == original_parts(row["path"]):
                require(found is None, "Ambiguous parked file")
                found = entry
    require(found is not None, "Parked file unavailable")
    require(found["sha256"].lower() == row["sha256"].lower() and int(found["size_bytes"]) == row["size_bytes"])
    parked = original_parts(found["parked_path"])
    prefix = original_parts(config.get("parkingPathPrefix", config["parkingRoot"]))
    require(parked.is_relative_to(prefix))
    relative = parked.relative_to(prefix)
    require(relative.parts and all(p not in (".", "..") and "/" not in p and "\\" not in p and ":" not in p for p in relative.parts))
    return Path(*relative.parts)


def file_hash(handle):
    handle.seek(0)
    value = hashlib.file_digest(handle, "sha256").hexdigest()
    handle.seek(0)
    return value


def safe_name(row):
    name = original_parts(row["path"]).name
    name = re.sub(r"[^\w. -]", "_", name, flags=re.ASCII).strip(" .")[:100] or "file"
    return str(row["id"]) + "-" + name


def transfer(config, row, source_relative, destination, execute):
    name = safe_name(row)
    expected = row["sha256"].lower()
    with descendant(config["parkingRoot"], source_relative) as (source_parent, source_name), directory(destination) as target_parent:
        fd = os.open(source_name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_parent)
        with os.fdopen(fd, "rb") as source:
            require(stat.S_ISREG(os.fstat(source.fileno()).st_mode) and os.fstat(source.fileno()).st_size == row["size_bytes"])
            require(file_hash(source) == expected, "Source hash mismatch")
            try:
                existing = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=target_parent)
            except FileNotFoundError:
                existing = None
            if existing is not None:
                with os.fdopen(existing, "rb") as target:
                    require(stat.S_ISREG(os.fstat(target.fileno()).st_mode) and file_hash(target) == expected, "Destination conflict")
                return "already-present"
            if not execute:
                return "dry-run"
            fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target_parent)
            with os.fdopen(fd, "w+b") as target:
                # Bounded streaming; never overwrite, rename, or remove a source or destination.
                remaining = row["size_bytes"]
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    require(chunk, "Source changed during copy")
                    target.write(chunk)
                    remaining -= len(chunk)
                require(not source.read(1), "Source changed during copy")
                target.flush()
                os.fsync(target.fileno())
                require(file_hash(target) == expected, "Copied hash mismatch")
            os.fsync(target_parent)
            return "copied"


def destination_present(destination, name, expected):
    with directory(destination) as parent:
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        except FileNotFoundError:
            return False
        with os.fdopen(fd, "rb") as target:
            require(stat.S_ISREG(os.fstat(target.fileno()).st_mode) and file_hash(target) == expected,
                    "Destination conflict")
        return True


def held_packet(config, packet_id, execute):
    content = read_relative(config["routerRoot"], "inbox/claimed/" + packet_id + ".md")
    blocks = re.findall(rb"```json\n([^`]+)\n```", content)
    require(len(blocks) == 1)
    body = json.loads(blocks[0])
    require(isinstance(body, dict) and isinstance(body.get("request"), dict))
    principal_key = body["request"].get("principal")
    matches = [p for p in config["principals"] if p["key"] == principal_key]
    require(len(matches) == 1)
    principal = matches[0]
    payload = parse_packet(config, principal, content, allow_expired=True)
    require(payload["packetId"] == packet_id)
    created = datetime.fromisoformat(payload["createdAt"])
    expired = (datetime.now(timezone.utc) - created).total_seconds() > 48 * 3600
    expected = {"status": "held", "packetId": packet_id, "packetSha256": digest(content),
                "principal": principal["key"]}
    if execute and not expired:
        with directory(config["heldRoot"]) as parent:
            staging = packet_id + "." + uuid.uuid4().hex + ".pending"
            fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=parent)
            try:
                with os.fdopen(fd, "wb") as target:
                    target.write(canonical(expected))
                    target.flush()
                    os.fsync(target.fileno())
                try:
                    os.link(staging, packet_id + ".json", src_dir_fd=parent, dst_dir_fd=parent,
                            follow_symlinks=False)
                except FileExistsError:
                    pass
                os.fsync(parent)
            finally:
                os.unlink(staging, dir_fd=parent)
    try:
        held = json.loads(read_relative(config["heldRoot"], packet_id + ".json"))
    except FileNotFoundError:
        require(not execute and not expired)
    else:
        require(held == expected)
    require(not expired or execute)
    return principal, payload, expired


def courier(config, packet_id, execute=False):
    require(isinstance(packet_id, str) and re.fullmatch(r"pkt-retrieval-[0-9a-f]{32}", packet_id))
    principal, payload, expired = held_packet(config, packet_id, execute)
    destination = destination_root(config, principal)
    result = {"packetId": packet_id, "status": "refused"}
    if not execute:
        row = file_record(config, principal, payload["fileId"])
        source = parked_record(config, row)
        result["status"] = transfer(config, row, source, destination, False)
        return result
    import fcntl
    audit = Path(config["auditLog"])
    with directory(audit.parent) as parent:
        fd = os.open(audit.name, os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
        with os.fdopen(fd, "a+", encoding="utf-8") as journal:
            require(stat.S_ISREG(os.fstat(journal.fileno()).st_mode))
            fcntl.flock(journal.fileno(), fcntl.LOCK_EX)
            os.fsync(parent)
            journal.seek(0)
            content = journal.read()
            if content and not content.endswith("\n"):
                end = content.rfind("\n") + 1
                journal.truncate(end)
                journal.flush()
                os.fsync(journal.fileno())
                content = content[:end]
            entries = [json.loads(line) for line in content.splitlines() if line.strip()]
            intents = [entry for entry in entries if entry.get("packetId") == packet_id and entry.get("phase") == "intent"]
            outcomes = {entry.get("transactionId") for entry in entries if entry.get("phase") == "outcome"}
            pending = [entry for entry in intents if entry["transactionId"] not in outcomes]
            require(len(pending) <= 1)
            prior = intents[-1] if intents else None
            record = pending[0] if pending else None
            require(record is None or record is prior)

            def append(entry, phase, status=None):
                event = {**entry, "phase": phase, "utc": datetime.now(timezone.utc).isoformat()}
                if status is not None:
                    event["status"] = status
                journal.write(json.dumps(event, separators=(",", ":")) + "\n")
                journal.flush()
                os.fsync(journal.fileno())

            if prior:
                path = Path(prior.get("destination", ""))
                source_path = Path(prior.get("source", ""))
                require(prior.get("packetId") == packet_id and prior.get("fileId") == payload["fileId"])
                require(prior.get("principal") == principal["key"] and prior.get("requestingBot") == principal["botId"])
                require(isinstance(prior.get("sha256"), str) and re.fullmatch(r"[0-9a-f]{64}", prior["sha256"]))
                require(path.parent == Path(destination) and path.name.startswith(payload["fileId"] + "-"))
                require(source_path.is_relative_to(Path(config["parkingRoot"])) and ".." not in source_path.parts)
            if record:
                try:
                    if destination_present(destination, path.name, record["sha256"]):
                        append(record, "outcome", "reconciled")
                        return {"packetId": packet_id, "status": "already-present"}
                except Exception:
                    append(record, "outcome", "refused")
                    raise
                append(record, "outcome", "interrupted")
                require(not expired)
            else:
                require(not expired)
            row = file_record(config, principal, payload["fileId"])
            source = parked_record(config, row)
            record = {
                "transactionId": uuid.uuid4().hex, "packetId": packet_id,
                "fileId": payload["fileId"], "requestingBot": principal["botId"],
                "principal": principal["key"], "sha256": row["sha256"].lower(),
                "source": str(Path(config["parkingRoot"]) / source),
                "destination": str(Path(destination) / safe_name(row)),
            }
            if prior:
                require(all(prior.get(key) == value for key, value in record.items() if key != "transactionId"))
            append(record, "intent")
            try:
                result["status"] = transfer(config, row, source, destination, True)
                return result
            finally:
                append(record, "outcome", result["status"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("operation", choices=("search", "request", "courier"))
    parser.add_argument("--packet-id")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    try:
        config = validate_config(json.loads(Path(args.config).read_text(encoding="utf-8")))
        config_path = Path(args.config).resolve()
        require(all(not config_path.is_relative_to(Path(destination_root(config, p)).resolve()) for p in config["principals"]))
        if args.operation == "courier":
            result = courier(config, args.packet_id, args.execute)
        else:
            require(not args.execute)
            data = json.loads(sys.stdin.buffer.read(8193))
            principal = principal_for(config, data["identity"])
            result = (search if args.operation == "search" else submit)(config, principal, data["args"])
        print(json.dumps(result, separators=(",", ":")))
    except Exception:
        # OS/SQLite/parser errors can contain host paths or private catalog text.
        print(json.dumps({"error": "Catalog operation refused"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
