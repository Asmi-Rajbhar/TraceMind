# This standardizes the timestamps and severity levels and ensures that malformed entries are rejected instead of silently corrupting the timeline.
from datetime import datetime, timezone


def normalize_logs(logs: list[dict]) -> list[dict]:
    result = []

    for index, log in enumerate(logs):
        timestamp = log.get("timestamp")

        if not timestamp:
            raise ValueError(
                f"Missing timestamp at event {index}"
            )

        parsed = datetime.fromisoformat(
            timestamp.replace("Z", "+00:00")
        )

        if parsed.tzinfo is None:
            raise ValueError(
                f"Timestamp needs a timezone at event {index}"
            )

        if not log.get("service") or not log.get("message"):
            raise ValueError(
                f"Missing service or message at event {index}"
            )

        result.append({
            "timestamp": parsed.astimezone(
                timezone.utc
            ).isoformat(),
            "service": str(log["service"]),
            "level": str(log.get("level", "INFO")).upper(),
            "trace_id": log.get("trace_id"),
            "message": str(log["message"]),
        })

    return sorted(
        result,
        key=lambda event: event["timestamp"]
    )