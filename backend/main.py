
# backend/main.py

import uuid
import asyncio
import json
import logging

from pydantic import BaseModel

from services.blockchain import (
    register_evidence,
    verify_evidence,
)

from services.relayer import (
    prepare_relay_request,
    submit_relay_request,
    verify_relayed_evidence,
)

from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from services.parser import normalize_logs
from services.investigator import investigate as investigate_with_rules
from services.ai_investigator import investigate_with_gemini
from services.timeline import build_timeline

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tracemind")

app = FastAPI(title="TraceMind API")

class EvidenceRequest(BaseModel):
    incident_id: str
    logs: list[dict]
    report: dict

class PrepareRelayRequest(BaseModel):
    incident_id: str
    logs: list[dict]
    report: dict
    sender: str


class SubmitRelayRequest(BaseModel):
    incident_id: str
    logs: list[dict]
    report: dict
    sender: str
    nonce: int
    deadline: int
    signature: str

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "https://trace-mind-lilac.vercel.app",

    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def health():
    return {"status": "ok", "service": "TraceMind"}


async def run_investigation(logs: list[dict]) -> dict:
    """
    Try Gemini first. If it fails, use the rule-based engine.
    Run the synchronous SDK call in a worker thread so it does
    not block FastAPI's event loop.
    """

    try:
        result = await asyncio.to_thread(
            investigate_with_gemini,
            logs,
        )
        logger.info("Incident investigated using Gemini")
        return result

    except Exception:
        logger.exception(
            "Gemini investigation failed; using rule-based fallback"
        )

        result = investigate_with_rules(logs)
        result["engine"] = "rules_fallback"
        result["ai_fallback"] = True
        return result


@app.get("/api/incidents/demo")
async def demo_incident():
    path = (
        Path(__file__).parent
        / "sample_logs"
        / "checkout_failure.json"
    )

    try:
        raw_logs = json.loads(
            path.read_text(encoding="utf-8")
        )
        logs = normalize_logs(raw_logs)

    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        logger.exception("Could not load demo incident")
        raise HTTPException(
            status_code=500,
            detail="Could not load the demo incident",
        ) from exc

    investigation = await run_investigation(logs)

    return {
        "incident_id": "INC-001",
        "title": "Checkout Service Failure",
        "severity": "HIGH",
        "logs": logs,
        "investigation": investigation,
        "timeline": build_timeline(logs),
    }


@app.post("/api/investigate")
async def investigate_file(file: UploadFile = File(...)):
    if (
        not file.filename
        or not file.filename.lower().endswith(".json")
    ):
        raise HTTPException(
            status_code=400,
            detail="Upload a JSON log file",
        )

    raw = await file.read()

    if len(raw) > 5_000_000:
        raise HTTPException(
            status_code=413,
            detail="Maximum upload size is 5 MB",
        )

    try:
        logs = json.loads(raw)

        if not isinstance(logs, list) or len(logs) > 10000:
            raise ValueError(
                "Expected up to 10,000 log events"
            )

        logs = normalize_logs(logs)

    except (
        ValueError,
        TypeError,
        json.JSONDecodeError,
    ) as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc

    investigation = await run_investigation(logs)

    incident_id = f"INC-{uuid.uuid4().hex[:12].upper()}"

    return {
        "incident_id": incident_id,
        "logs": logs,
        "investigation": investigation,
        "timeline": build_timeline(logs),
    }

@app.post("/api/evidence/register")
async def register_incident_evidence(request: EvidenceRequest):
    try:
        result = await asyncio.to_thread(
            register_evidence,
            request.incident_id,
            request.logs,
            request.report,
        )
        return result

    except ValueError as exc:
        status_code = (
            409 if "already registered" in str(exc).lower() else 400
        )
        raise HTTPException(
            status_code=status_code,
            detail=str(exc),
        ) from exc

    except Exception as exc:
        logger.exception("Blockchain evidence registration failed")
        raise HTTPException(
            status_code=503,
            detail="Blockchain registration failed. Check backend logs.",
        ) from exc


@app.post("/api/evidence/verify")
async def verify_incident_evidence(request: EvidenceRequest):
    try:
        return await asyncio.to_thread(
            verify_evidence,
            request.incident_id,
            request.logs,
            request.report,
        )

    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc

    except Exception as exc:
        logger.exception("Blockchain evidence verification failed")
        raise HTTPException(
            status_code=503,
            detail="Blockchain verification failed. Check backend logs.",
        ) from exc


@app.post("/api/evidence/relay/prepare")
async def prepare_incident_relay(request: PrepareRelayRequest):
    """
    Prepare an EIP-712 request for the user's MetaMask signature.
    Does not submit a blockchain transaction.
    """
    try:
        return await asyncio.to_thread(
            prepare_relay_request,
            request.incident_id,
            request.logs,
            request.report,
            request.sender,
        )

    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc

    except Exception as exc:
        logger.exception("Could not prepare relayer request")
        raise HTTPException(
            status_code=503,
            detail="Could not prepare the blockchain request",
        ) from exc


@app.post("/api/evidence/relay/submit")
async def submit_incident_relay(request: SubmitRelayRequest):
    """
    Submit the user's signed EIP-712 request through the relayer.
    """
    try:
        return await asyncio.to_thread(
            submit_relay_request,
            request.incident_id,
            request.logs,
            request.report,
            request.sender,
            request.nonce,
            request.deadline,
            request.signature,
        )

    except ValueError as exc:
        message = str(exc).lower()

        status_code = (
            409
            if "already registered" in message
            or "nonce" in message
            else 400
        )

        raise HTTPException(
            status_code=status_code,
            detail=str(exc),
        ) from exc

    except Exception as exc:
        logger.exception("Relayed blockchain registration failed")
        raise HTTPException(
            status_code=503,
            detail="Relayed registration failed. Check backend logs.",
        ) from exc


@app.post("/api/evidence/verify-2771")
async def verify_2771_incident_evidence(request: EvidenceRequest):
    """
    Verify evidence against EvidenceRegistry2771.
    """
    try:
        return await asyncio.to_thread(
            verify_relayed_evidence,
            request.incident_id,
            request.logs,
            request.report,
        )

    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc

    except Exception as exc:
        logger.exception("ERC-2771 evidence verification failed")
        raise HTTPException(
            status_code=503,
            detail="Evidence verification failed. Check backend logs.",
        ) from exc
