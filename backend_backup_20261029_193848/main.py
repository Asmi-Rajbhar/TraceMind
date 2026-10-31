import json
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from services.parser import normalize_logs
from services.investigator import investigate

app = FastAPI(title="TraceMind API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def health():
    return {"status": "ok", "service": "TraceMind"}


@app.get("/api/incidents/demo")
def demo_incident():
    path = (
        Path(__file__).parent
        / "sample_logs"
        / "checkout_failure.json"
    )

    logs = json.loads(
        path.read_text(encoding="utf-8")
    )

    logs = normalize_logs(logs)

    return {
        "incident_id": "INC-001",
        "title": "Checkout Service Failure",
        "severity": "HIGH",
        "logs": logs,
        "investigation": investigate(logs),
    }


@app.post("/api/investigate")
async def investigate_file(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".json"):
        raise HTTPException(
            status_code=400,
            detail="Upload a JSON log file"
        )

    raw = await file.read()

    if len(raw) > 5_000_000:
        raise HTTPException(
            status_code=413,
            detail="Maximum upload size is 5 MB"
        )

    try:
        logs = json.loads(raw)

        if not isinstance(logs, list) or len(logs) > 10000:
            raise ValueError("Expected up to 10,000 log events")

        logs = normalize_logs(logs)

    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc)
        ) from exc

    return {
        "incident_id": "INC-UPLOAD",
        "logs": logs,
        "investigation": investigate(logs),
    }