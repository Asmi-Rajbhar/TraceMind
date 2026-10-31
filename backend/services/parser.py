
# backend/services/parser.py

import re
from datetime import datetime, timezone
from typing import Any


# Common timestamp formats found in application logs.
TIMESTAMP_FORMATS = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M:%S,%f",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%d/%b/%Y:%H:%M:%S %z",
)


SEVERITY_ALIASES = {
    "FATAL": "CRITICAL",
    "SEVERE": "ERROR",
    "ERR": "ERROR",
    "WARNING": "WARN",
    "INFORMATION": "INFO",
    "INFORMATIONAL": "INFO",
    "TRACE": "DEBUG",
}


# These rules provide an initial classification without an AI model.
# More advanced context-aware classification will be added later.
SEVERITY_PATTERNS = [
    (
        "CRITICAL",
        0.95,
        re.compile(
            r"\b(fatal|critical|unrecoverable|system halted)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "ERROR",
        0.90,
        re.compile(
            r"\b(exception|stack trace|connection refused|"
            r"connection timed out|database connection timeout|"
            r"internal server error|http 5\d\d|"
            r"payment processing failed|request failed|"
            r"operation failed|failure occurred|failed to)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "WARN",
        0.80,
        re.compile(
            r"\b(timeout|timed out|retrying|retry attempt|"
            r"rate limit|degraded|slow response|"
            r"high latency|unavailable temporarily)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "INFO",
        0.75,
        re.compile(
            r"\b(request received|request completed|"
            r"successfully completed|operation succeeded|"
            r"service started|service stopped|"
            r"health check passed|connected successfully)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "DEBUG",
        0.80,
        re.compile(
            r"\b(debug|verbose|trace details)\b",
            re.IGNORECASE,
        ),
    ),
]


EVENT_PATTERNS = [
    (
        "DATABASE_CONNECTION_FAILURE",
        re.compile(
            r"\b(database connection timeout|database connection failed|"
            r"database unavailable|connection refused.*database)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "DEPENDENCY_TIMEOUT",
        re.compile(
            r"\b(connection timed out|connection timeout|"
            r"request timed out|request timeout|"
            r"timed out while calling|timeout while calling)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "RETRY",
        re.compile(
            r"\b(retrying|retry attempt|retrying request|"
            r"retry scheduled|will retry)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "REQUEST_FAILURE",
        re.compile(
            r"\b(request failed|operation failed|"
            r"payment processing failed|checkout failed|"
            r"internal server error|http 5\d\d)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "AUTHENTICATION_FAILURE",
        re.compile(
            r"\b(unauthorized|authentication failed|"
            r"invalid credentials|access denied|permission denied)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "RECOVERY",
        re.compile(
            r"\b(recovered|recovery complete|"
            r"service restored|back to normal|"
            r"connection re-established)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "REQUEST_START",
        re.compile(
            r"\b(incoming request|request received|"
            r"request started|processing request)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "REQUEST_SUCCESS",
        re.compile(
            r"\b(request completed|request succeeded|"
            r"successfully completed|operation succeeded)\b",
            re.IGNORECASE,
        ),
    ),
]


def parse_timestamp(value: Any, index: int) -> tuple[datetime, bool]:
    """Parse a supported timestamp and return (UTC datetime, assumed_utc)."""

    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Missing or invalid timestamp at event {index}")

    value = value.strip()

    # Handle ISO-8601 timestamps, including timestamps ending in Z.
    try:
        parsed = datetime.fromisoformat(
            value[:-1] + "+00:00" if value.endswith("Z") else value
        )
    except ValueError:
        parsed = None

    # Try common application-log timestamp formats.
    if parsed is None:
        for fmt in TIMESTAMP_FORMATS:
            try:
                parsed = datetime.strptime(value, fmt)
                break
            except ValueError:
                continue

    if parsed is None:
        raise ValueError(
            f"Unsupported timestamp format at event {index}: {value}"
        )

    assumed_utc = parsed.tzinfo is None

    # A timezone-free timestamp is interpreted as UTC, but we explicitly
    # record that this assumption was made.
    if assumed_utc:
        parsed = parsed.replace(tzinfo=timezone.utc)

    return parsed.astimezone(timezone.utc), assumed_utc


def classify_severity(
    message: str,
    original_level: Any,
) -> tuple[str, str, float]:
    """Return normalized severity, its source, and confidence."""

    if original_level is not None and str(original_level).strip():
        original = str(original_level).strip().upper()
        normalized = SEVERITY_ALIASES.get(original, original)

        allowed_levels = {
            "DEBUG", "INFO", "NOTICE", "WARN",
            "ERROR", "CRITICAL", "UNKNOWN",
        }

        if normalized in allowed_levels:
            return normalized, "original", 1.0

        # Unknown labels should not be silently treated as INFO.
        return "UNKNOWN", "unrecognized_original", 0.0

    for severity, confidence, pattern in SEVERITY_PATTERNS:
        if pattern.search(message):
            return severity, "rule_inferred", confidence

    return "UNKNOWN", "unknown", 0.0


def classify_event_type(message: str) -> tuple[str, str, float]:
    """Infer a useful event category from the message."""

    for event_type, pattern in EVENT_PATTERNS:
        if pattern.search(message):
            return event_type, "rule_inferred", 0.85

    return "GENERAL_EVENT", "unknown", 0.0


def normalize_logs(logs: list[dict]) -> list[dict]:
    """Validate and normalize logs while preserving their original content."""

    if not isinstance(logs, list):
        raise ValueError("Expected a list of log events")

    result = []

    for index, log in enumerate(logs):
        if not isinstance(log, dict):
            raise ValueError(f"Event {index} must be a JSON object")

        timestamp_value = log.get("timestamp") or log.get("@timestamp")
        parsed_timestamp, assumed_utc = parse_timestamp(
            timestamp_value, index
        )

        raw_message = (
            log.get("message")
            or log.get("msg")
            or log.get("event")
        )

        if raw_message is None or not str(raw_message).strip():
            raise ValueError(f"Missing message at event {index}")

        message = str(raw_message).strip()

        service_value = (
            log.get("service")
            or log.get("service_name")
            or log.get("logger")
            or log.get("application")
        )

        service = (
            str(service_value).strip()
            if service_value is not None and str(service_value).strip()
            else "unknown-service"
        )

        original_level = log.get("level", log.get("severity"))
        level, severity_source, severity_confidence = classify_severity(
            message, original_level
        )

        event_type, event_type_source, event_confidence = (
            classify_event_type(message)
        )

        trace_id = (
            log.get("trace_id")
            or log.get("traceId")
            or log.get("trace.id")
            or log.get("request_id")
            or log.get("requestId")
        )

        normalized = {
            # Existing fields retained for frontend compatibility.
            "timestamp": parsed_timestamp.isoformat(),
            "service": service,
            "level": level,
            "trace_id": str(trace_id) if trace_id is not None else None,
            "message": message,

            # Additional intelligence and provenance.
            "original_level": (
                str(original_level) if original_level is not None else None
            ),
            "severity_source": severity_source,
            "severity_confidence": severity_confidence,
            "event_type": event_type,
            "event_type_source": event_type_source,
            "event_confidence": event_confidence,
            "timestamp_timezone_assumed_utc": assumed_utc,
            "raw_message": message,
        }

        result.append(normalized)

    # ISO-formatted UTC timestamps can be sorted consistently.
    return sorted(result, key=lambda event: event["timestamp"])
