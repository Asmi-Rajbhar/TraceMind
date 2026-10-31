
# backend/services/timeline.py

from datetime import datetime


FAILURE_LEVELS = {"ERROR", "CRITICAL"}

START_TYPES = {
    "REQUEST_START",
}

RECOVERY_TYPES = {
    "RECOVERY",
}

SUCCESS_TYPES = {
    "REQUEST_SUCCESS",
}


def parse_timestamp(value):
    """Parse a timestamp into a datetime."""
    if not isinstance(value, str):
        return None

    try:
        return datetime.fromisoformat(
            value.replace("Z", "+00:00")
        )
    except ValueError:
        return None


def describe_event(event):
    """Describe the observed event without inventing a cause."""

    level = event.get("level", "UNKNOWN")
    event_type = event.get("event_type", "GENERAL_EVENT")
    message = event.get("message", "No message")
    service = event.get("service", "unknown-service")

    if event_type == "DATABASE_CONNECTION_FAILURE":
        return (
            f"{service} reported a database connectivity problem: "
            f"{message}"
        )

    if event_type == "DEPENDENCY_TIMEOUT":
        return (
            f"{service} reported a dependency timeout: {message}"
        )

    if event_type == "AUTHENTICATION_FAILURE":
        return (
            f"{service} reported an authentication or permission "
            f"problem: {message}"
        )

    if event_type == "REQUEST_FAILURE":
        return f"{service} reported a request failure: {message}"

    if event_type == "RETRY":
        return f"{service} reported a retry event: {message}"

    if event_type in RECOVERY_TYPES:
        return f"{service} reported recovery: {message}"

    if event_type in SUCCESS_TYPES:
        return f"{service} reported successful completion: {message}"

    if event_type in START_TYPES:
        return f"{service} started processing: {message}"

    if level in FAILURE_LEVELS:
        return f"{service} reported an error: {message}"

    return f"{service}: {message}"


def classify_timeline_role(event, first_failure):
    """Assign a timeline label based on observed fields and ordering."""

    event_type = event.get("event_type", "GENERAL_EVENT")
    level = event.get("level", "UNKNOWN")

    if event_type in RECOVERY_TYPES:
        return "recovery"

    if event_type in SUCCESS_TYPES:
        return "success"

    if event_type in START_TYPES:
        return "request_start"

    is_failure = (
        level in FAILURE_LEVELS
        or event_type in {
            "DATABASE_CONNECTION_FAILURE",
            "DEPENDENCY_TIMEOUT",
            "AUTHENTICATION_FAILURE",
            "REQUEST_FAILURE",
        }
    )

    if not is_failure:
        return "activity"

    if first_failure is None:
        return "failure"

    if event is first_failure:
        return "first_observed_failure"

    return "subsequent_failure"


def build_timeline(logs: list[dict]) -> dict:
    """
    Build a chronological incident timeline.

    The timeline describes ordering and shared trace IDs. It does not
    claim that chronological order alone proves causation.
    """

    ordered_logs = sorted(
        logs,
        key=lambda event: (
            parse_timestamp(event.get("timestamp")) is None,
            parse_timestamp(event.get("timestamp"))
            or datetime.min,
        ),
    )

    failures = [
        event for event in ordered_logs
        if (
            event.get("level") in FAILURE_LEVELS
            or event.get("event_type") in {
                "DATABASE_CONNECTION_FAILURE",
                "DEPENDENCY_TIMEOUT",
                "AUTHENTICATION_FAILURE",
                "REQUEST_FAILURE",
            }
        )
    ]

    first_failure = failures[0] if failures else None

    timeline_events = []

    for index, event in enumerate(ordered_logs, start=1):
        role = classify_timeline_role(event, first_failure)

        timeline_events.append({
            "sequence": index,
            "timestamp": event.get("timestamp"),
            "service": event.get("service", "unknown-service"),
            "level": event.get("level", "UNKNOWN"),
            "event_type": event.get(
                "event_type", "GENERAL_EVENT"
            ),
            "trace_id": event.get("trace_id"),
            "message": event.get("message", ""),
            "role": role,
            "description": describe_event(event),
        })

    relationships = []

    if first_failure is not None:
        first_timestamp = first_failure.get("timestamp")
        first_trace = first_failure.get("trace_id")

        for event in failures[1:]:
            same_trace = (
                first_trace is not None
                and event.get("trace_id") == first_trace
            )

            relationships.append({
                "from_timestamp": first_timestamp,
                "to_timestamp": event.get("timestamp"),
                "type": (
                    "same_trace_later_failure"
                    if same_trace
                    else "later_failure"
                ),
                "explanation": (
                    "This failure occurred later and shares the same "
                    "trace ID as the first observed failure."
                    if same_trace
                    else
                    "This failure occurred later, but a shared trace "
                    "ID was not established."
                ),
                "causation_confirmed": False,
            })

    if not ordered_logs:
        story = "No events were available to build a timeline."
    elif first_failure is None:
        story = (
            f"{len(ordered_logs)} events were found, but no clear "
            "failure event was identified."
        )
    else:
        story = (
            f"{len(ordered_logs)} events were found. The first observed "
            f"failure was reported by "
            f"{first_failure.get('service', 'unknown-service')}: "
            f"{first_failure.get('message', 'No message')}. "
            "Later events are shown in chronological order. "
            "Their ordering does not by itself prove causation."
        )

    return {
        "story": story,
        "event_count": len(timeline_events),
        "failure_count": len(failures),
        "first_failure_timestamp": (
            first_failure.get("timestamp")
            if first_failure else None
        ),
        "events": timeline_events,
        "relationships": relationships,
    }
