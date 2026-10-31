import os
import json
from pathlib import Path

from dotenv import load_dotenv
from web3 import Web3

from services.hashing import hash_logs, hash_report


# Load backend/.env
BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BACKEND_DIR.parent

load_dotenv(BACKEND_DIR / ".env")

RPC_URL = os.getenv("MST_RPC_URL")
CHAIN_ID = int(os.getenv("MST_CHAIN_ID", "91562037"))
CONTRACT_ADDRESS = os.getenv("MST_CONTRACT_ADDRESS")
PRIVATE_KEY = os.getenv("MST_PRIVATE_KEY")

ABI_PATH = (
    PROJECT_DIR
    / "packages"
    / "contracts"
    / "artifacts"
    / "contracts"
    / "EvidenceRegistry.sol"
    / "EvidenceRegistry.json"
)


def get_blockchain_connection():
    """Connect to MST Testnet and load the deployed contract."""

    if not all([RPC_URL, CONTRACT_ADDRESS, PRIVATE_KEY]):
        raise RuntimeError(
            "Missing MST blockchain configuration in backend/.env"
        )

    w3 = Web3(Web3.HTTPProvider(RPC_URL, request_kwargs={"timeout": 30}))

    if not w3.is_connected():
        raise RuntimeError("Could not connect to MST Testnet")

    if w3.eth.chain_id != CHAIN_ID:
        raise RuntimeError(
            f"Wrong blockchain network. Expected {CHAIN_ID}, "
            f"connected to {w3.eth.chain_id}"
        )

    if not ABI_PATH.exists():
        raise RuntimeError(f"Contract ABI not found: {ABI_PATH}")

    with ABI_PATH.open("r", encoding="utf-8") as file:
        artifact = json.load(file)

    contract_address = Web3.to_checksum_address(CONTRACT_ADDRESS)

    if not w3.eth.get_code(contract_address):
        raise RuntimeError(
            "No deployed contract found at the configured address"
        )

    contract = w3.eth.contract(
        address=contract_address,
        abi=artifact["abi"],
    )

    account = w3.eth.account.from_key(PRIVATE_KEY)

    return w3, contract, account


def _hash_to_bytes32(hash_value: str) -> bytes:
    """Convert a 64-character SHA-256 hex digest into bytes32."""

    clean_hash = hash_value.removeprefix("0x")

    if len(clean_hash) != 64:
        raise ValueError("Invalid SHA-256 hash length")

    try:
        result = bytes.fromhex(clean_hash)
    except ValueError as exc:
        raise ValueError("Invalid hexadecimal hash") from exc

    if len(result) != 32:
        raise ValueError("Hash must be exactly 32 bytes")

    return result


def register_evidence(
    incident_id: str,
    logs: list[dict],
    report: dict,
) -> dict:
    """Register incident log and report hashes on MST Testnet."""

    if not incident_id or not incident_id.strip():
        raise ValueError("Incident ID is required")

    log_hash = hash_logs(logs)
    report_hash = hash_report(report)

    log_hash_bytes = _hash_to_bytes32(log_hash)
    report_hash_bytes = _hash_to_bytes32(report_hash)

    w3, contract, account = get_blockchain_connection()

    already_registered = contract.functions.exists(
        incident_id
    ).call()

    if already_registered:
        raise ValueError(
            "Evidence is already registered for this incident ID"
        )

    register_function = contract.functions.registerEvidence(
        incident_id,
        log_hash_bytes,
        report_hash_bytes,
    )

    nonce = w3.eth.get_transaction_count(
        account.address,
        "pending",
    )

    gas_estimate = register_function.estimate_gas(
        {"from": account.address}
    )

    transaction = register_function.build_transaction({
        "from": account.address,
        "nonce": nonce,
        "chainId": CHAIN_ID,
        "gas": int(gas_estimate * 1.2),
        "gasPrice": w3.eth.gas_price,
    })

    signed_transaction = account.sign_transaction(transaction)

    transaction_hash = w3.eth.send_raw_transaction(
        signed_transaction.raw_transaction
    )

    receipt = w3.eth.wait_for_transaction_receipt(
        transaction_hash,
        timeout=120,
    )

    if receipt["status"] != 1:
        raise RuntimeError("Blockchain registration transaction failed")

    return {
        "incident_id": incident_id,
        "registered": True,
        "log_hash": log_hash,
        "report_hash": report_hash,
        "transaction_hash": transaction_hash.hex(),
        "block_number": receipt["blockNumber"],
        "gas_used": receipt["gasUsed"],
        "registered_by": account.address,
        "contract_address": contract.address,
        "network": "MST Testnet",
    }


def verify_evidence(
    incident_id: str,
    logs: list[dict],
    report: dict,
) -> dict:
    """Compare current evidence hashes with the on-chain record."""

    if not incident_id or not incident_id.strip():
        raise ValueError("Incident ID is required")

    log_hash = hash_logs(logs)
    report_hash = hash_report(report)

    log_hash_bytes = _hash_to_bytes32(log_hash)
    report_hash_bytes = _hash_to_bytes32(report_hash)

    w3, contract, _ = get_blockchain_connection()

    exists = contract.functions.exists(incident_id).call()

    if not exists:
        return {
            "incident_id": incident_id,
            "registered": False,
            "verified": False,
            "message": "No evidence is registered for this incident",
        }

    verified = contract.functions.verifyEvidence(
        incident_id,
        log_hash_bytes,
        report_hash_bytes,
    ).call()

    stored = contract.functions.getEvidence(
        incident_id
    ).call()

    return {
        "incident_id": incident_id,
        "registered": True,
        "verified": verified,
        "message": (
            "Evidence matches the blockchain record"
            if verified
            else "Evidence does not match the blockchain record"
        ),
        "current_log_hash": log_hash,
        "current_report_hash": report_hash,
        "stored_log_hash": Web3.to_hex(stored[0]),
        "stored_report_hash": Web3.to_hex(stored[1]),
        "registered_at": stored[2],
        "registered_by": stored[3],
        "contract_address": contract.address,
        "network": "MST Testnet",
    }