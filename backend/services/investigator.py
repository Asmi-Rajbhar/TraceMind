
# backend/services/investigator.py

from collections import Counter
from datetime import datetime, timezone

CAUSE_RULES = [
    {
        "event_type": "DATABASE_CONNECTION_FAILURE",
        "cause": "Database connectivity failure",
        "keywords": [
            "database connection",
            "database unavailable",
            "connection refused",
            "connection pool exhausted",
        ],
        "base_strength": 0.72,
        "next_checks": [
            "Check whether the database was reachable at the incident time.",
            "Inspect database connection pool usage and exhausted connections.",
            "Review database server logs for connection refusals or restarts.",
        ],
        "alternatives": [
            "The database may have been healthy, but the application could have exhausted its own connection pool.",
            "A network interruption between the application and database may have caused the connection failure.",
        ],
    },
    {
        "event_type": "DEPENDENCY_TIMEOUT",
        "cause": "External or internal dependency timeout",
        "keywords": [
            "timed out",
            "timeout",
            "request timeout",
        ],
        "base_strength": 0.62,
        "next_checks": [
            "Identify which dependency the service was waiting for.",
            "Check dependency response times around the incident.",
            "Review timeout and retry configuration for the affected service.",
        ],
        "alternatives": [
            "The dependency may have been healthy but the calling service could have been overloaded.",
            "Network latency may have delayed the dependency response.",
        ],
    },
    {
        "event_type": "AUTHENTICATION_FAILURE",
        "cause": "Authentication or permission failure",
        "keywords": [
            "unauthorized",
            "authentication failed",
            "invalid credentials",
            "permission denied",
            "access denied",
        ],
        "base_strength": 0.70,
        "next_checks": [
            "Verify the credentials or token used by the affected service.",
            "Check token expiry and authentication configuration.",
            "Review permission changes around the incident time.",
        ],
        "alternatives": [
            "An expired or incorrectly configured token may have caused the failure.",
            "A permissions or access-policy change may have blocked the request.",
        ],
    },
    {
        "event_type": "RETRY",
        "cause": "Repeated retries or retry storm",
        "keywords": [
            "retrying",
            "retry attempt",
            "retry scheduled",
            "will retry",
        ],
        "base_strength": 0.50,
        "next_checks": [
            "Count retry attempts for the affected request or service.",
            "Check retry intervals, backoff settings, and maximum retry limits.",
            "Find the original error that triggered the retries.",
        ],
        "alternatives": [
            "Retries may be a response to another underlying failure rather than the original cause.",
            "An overly aggressive retry policy may have increased service load.",
        ],
    },
    {
        "event_type": "REQUEST_FAILURE",
        "cause": "Service request failure",
        "keywords": [
            "request failed",
            "operation failed",
            "payment processing failed",
            "checkout failed",
            "http 500",
            "internal server error",
        ],
        "base_strength": 0.48,
        "next_checks": [
            "Inspect the failed request and its associated trace ID.",
            "Check the service logs immediately before the request failed.",
            "Review the response status and error details from dependent services.",
        ],
        "alternatives": [
            "The request failure may be a downstream symptom of another service failure.",
            "An application-level validation or processing error may have caused the request to fail.",
        ],
    },
]


SPECIFIC_EVENT_TYPES = {
    "DATABASE_CONNECTION_FAILURE",
    "DEPENDENCY_TIMEOUT",
    "AUTHENTICATION_FAILURE",
    "REQUEST_FAILURE",
    "RETRY",
}


def parse_time(value):
    """Convert a timestamp into a comparable datetime."""
    # try:
    #     parsed = datetime.fromisoformat(
    #         value.replace("Z", "+00:00")
    #     )

    #     # Normalize timezone-aware values to naive UTC so timestamps
    #     # with different offsets can be compared safely.
    #     if parsed.tzinfo is not None:
    #         parsed = parsed.astimezone(
    #             datetime.now().astimezone().tzinfo
    #         ).replace(tzinfo=None)

    #     return parsed

    # except (ValueError, AttributeError, TypeError):
    #     return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)


def get_event_time(event):
    return parse_time(event.get("timestamp"))


def is_failure(event):
    return (
        event.get("level") in {"ERROR", "CRITICAL"}
        or event.get("event_type") in {
            "DATABASE_CONNECTION_FAILURE",
            "DEPENDENCY_TIMEOUT",
            "AUTHENTICATION_FAILURE",
            "REQUEST_FAILURE",
        }
    )


def matches_rule(event, rule):
    """
    Prefer the normalized event type over generic message keywords.

    This prevents a database timeout from also being classified as
    a generic dependency timeout when its event type is already known.
    """
    event_type = event.get("event_type", "")

    if event_type == rule["event_type"]:
        return True

    if event_type in SPECIFIC_EVENT_TYPES:
        return False

    message = str(event.get("message", "")).lower()

    return any(
        keyword in message
        for keyword in rule["keywords"]
    )


def get_service(events):
    counts = Counter(
        event.get("service", "unknown-service")
        for event in events
    )

    return counts.most_common(1)[0][0]


def investigate(logs: list[dict]) -> dict:
    """
    Rank possible causes using observed log evidence.

    Scores are heuristic ranking scores, not calibrated probabilities.
    Shared trace IDs and event ordering are supporting clues, not proof
    of causation.
    """

    if not logs:
        return {
            "summary": "No log events were available to investigate.",
            "hypotheses": [],
            "needs_review": True,
        }

    ordered_logs = sorted(
        logs,
        key=lambda event: (
            get_event_time(event) is None,
            get_event_time(event) or datetime.max,
        ),
    )

    failures = [
        event for event in ordered_logs
        if is_failure(event)
    ]

    if not failures:
        return {
            "summary": (
                "No clear failure events were detected. "
                "Review the logs or provide more incident evidence."
            ),
            "hypotheses": [],
            "needs_review": True,
        }

    hypotheses = []

    for rule in CAUSE_RULES:
        matching = [
            event for event in failures
            if matches_rule(event, rule)
        ]

        if not matching:
            continue

        first_match = min(
            matching,
            key=lambda event: (
                get_event_time(event) is None,
                get_event_time(event) or datetime.max,
            ),
        )

        first_time = get_event_time(first_match)
        trace_id = first_match.get("trace_id")

        same_trace_failures = [
            event for event in failures
            if trace_id
            and event.get("trace_id") == trace_id
            and get_event_time(event) is not None
        ]

        same_trace_later = [
            event for event in same_trace_failures
            if first_time is not None
            and get_event_time(event) > first_time
        ]

        earlier_same_trace = [
            event for event in same_trace_failures
            if first_time is not None
            and get_event_time(event) < first_time
        ]

        # Keep each score adjustment visible and explainable.
        score_breakdown = {
            "base_strength": rule["base_strength"],
            "severity_adjustment": 0.0,
            "repeated_event_adjustment": 0.0,
            "trace_support_adjustment": 0.0,
            "ordering_adjustment": 0.0,
            "earlier_failure_penalty": 0.0,
        }

        score = rule["base_strength"]

        if first_match.get("level") == "CRITICAL":
            score_breakdown["severity_adjustment"] = 0.12
        elif first_match.get("level") == "ERROR":
            score_breakdown["severity_adjustment"] = 0.08
        elif first_match.get("level") == "WARN":
            score_breakdown["severity_adjustment"] = 0.03

        score += score_breakdown["severity_adjustment"]

        if len(matching) > 1:
            score_breakdown["repeated_event_adjustment"] = min(
                0.08,
                (len(matching) - 1) * 0.03,
            )

        score += score_breakdown["repeated_event_adjustment"]

        if same_trace_later:
            score_breakdown["trace_support_adjustment"] = min(
                0.12,
                len(same_trace_later) * 0.04,
            )

        score += score_breakdown["trace_support_adjustment"]

        # Event ordering only contributes when later failures share
        # the candidate's trace ID.
        if same_trace_later:
            score_breakdown["ordering_adjustment"] = 0.04

        score += score_breakdown["ordering_adjustment"]

        if earlier_same_trace:
            score_breakdown["earlier_failure_penalty"] = -0.08

        score += score_breakdown["earlier_failure_penalty"]

        score = round(max(0.05, min(score, 0.99)), 2)

        reasons = [
            f"{len(matching)} matching failure event(s) support this candidate."
        ]

        if first_time is not None:
            reasons.append(
                f"The first matching event occurred at "
                f"{first_match.get('timestamp')}."
            )

        if same_trace_later:
            reasons.append(
                f"{len(same_trace_later)} later failure event(s) "
                "share its trace ID. This links the events to the same "
                "request but does not prove causation."
            )

        if earlier_same_trace:
            reasons.append(
                "An earlier failure exists in the same trace, "
                "so this candidate may be a downstream symptom."
            )
        elif same_trace_later:
            reasons.append(
                "This candidate appears before later failures in the "
                "same trace, making it worth investigating first."
            )

        # A candidate with an earlier failure in the same trace is
        # more likely to be a downstream symptom.
        investigation_role = (
            "possible_downstream_symptom"
            if earlier_same_trace
            else "possible_initiating_failure"
        )

        hypotheses.append({
            "cause": rule["cause"],
            "service": get_service(matching),
            "score": score,
            "investigation_score": score,
            "confidence_label": (
                "Higher relative support" if score >= 0.75
                else "Moderate relative support" if score >= 0.55
                else "Limited relative support"
            ),
            "investigation_role": investigation_role,
            "investigation_status": "unverified",
            "reason": " ".join(reasons),
            "why_suspected": " ".join(reasons),
            "score_breakdown": score_breakdown,
            "evidence": matching,
            "supporting_evidence": matching,
            "next_checks": rule["next_checks"],
            "alternative_explanations": rule["alternatives"],
        })

    if not hypotheses:
        hypotheses.append({
            "cause": "Unclassified application failure",
            "service": failures[0].get(
                "service", "unknown-service"
            ),
            "score": 0.25,
            "investigation_score": 0.25,
            "confidence_label": "Limited relative support",
            "investigation_role": "unknown",
            "investigation_status": "unverified",
            "reason": (
                "Failure events were found, but none matched a known "
                "cause pattern. More context or manual review is needed."
            ),
            "why_suspected": (
                "Failure events were found, but none matched a known "
                "cause pattern."
            ),
            "score_breakdown": {
                "note": "Fallback score because no known pattern matched."
            },
            "evidence": failures,
            "supporting_evidence": failures,
            "next_checks": [
                "Inspect the earliest failure and the events around it.",
                "Search for related events using the same trace ID.",
                "Check service dependencies and recent application changes.",
            ],
            "alternative_explanations": [
                "The failure may be caused by an issue not covered by the current detection rules."
            ],
        })

    hypotheses.sort(
        key=lambda item: item["score"],
        reverse=True,
    )

    # Add a clear ranking label after sorting.
    for index, hypothesis in enumerate(hypotheses):
        hypothesis["ranking"] = index + 1
        hypothesis["ranking_label"] = (
            "Leading hypothesis"
            if index == 0
            else "Alternative hypothesis"
        )

    top = hypotheses[0]

    needs_review = (
        top["score"] < 0.65
        or not top["evidence"]
        or top["investigation_role"] == "possible_downstream_symptom"
    )

    if needs_review:
        summary = (
            f"The leading candidate is {top['cause']}, but the available "
            "evidence is not sufficient to confirm it. Manual review "
            "is recommended."
        )
    else:
        summary = (
            f"The leading hypothesis is {top['cause']}. It has supporting "
            "log evidence, but it is not a confirmed root cause."
        )

    return {
        "summary": summary,
        "hypotheses": hypotheses,
        "needs_review": needs_review,
        "engine": "rules",
    }
