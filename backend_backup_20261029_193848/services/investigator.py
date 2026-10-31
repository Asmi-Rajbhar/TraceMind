def investigate(logs: list[dict]) -> dict:
    errors = [
        event for event in logs
        if event["level"] in {"ERROR", "CRITICAL"}
    ]

    rules = [
        {
            "keywords": [
                "database connection timeout",
                "connection refused",
            ],
            "cause": "Database connectivity failure",
            "service": "payment-service",
            "score": 0.95,
        },
        {
            "keywords": [
                "payment processing failed",
                "payment timeout",
            ],
            "cause": "Payment processing failure",
            "service": "payment-service",
            "score": 0.80,
        },
        {
            "keywords": [
                "http 500",
                "internal server error",
            ],
            "cause": "Gateway request failure",
            "service": "api-gateway",
            "score": 0.60,
        },
    ]

    hypotheses = []

    for rule in rules:
        evidence = [
            event for event in errors
            if any(
                keyword in event["message"].lower()
                for keyword in rule["keywords"]
            )
        ]

        if evidence:
            hypotheses.append({
                "cause": rule["cause"],
                "service": rule["service"],
                "score": rule["score"],
                "evidence": evidence,
            })

    hypotheses.sort(
        key=lambda item: item["score"],
        reverse=True
    )

    if not hypotheses:
        return {
            "summary": "Errors were detected, but no known rule matched.",
            "hypotheses": [],
            "needs_review": True,
        }

    return {
        "summary": (
            "The leading hypothesis is "
            + hypotheses[0]["cause"]
        ),
        "hypotheses": hypotheses,
        "needs_review": False,
    }