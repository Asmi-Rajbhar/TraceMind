import hashlib
import json


def canonical_json(data: object) -> bytes:
    return json.dumps(
        data,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_logs(logs: list[dict]) -> str:
    return sha256_hex(canonical_json(logs))


def hash_report(report: dict) -> str:
    return sha256_hex(canonical_json(report))