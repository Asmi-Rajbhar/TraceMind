
import os
import json
import time
import logging
from pathlib import Path

from dotenv import load_dotenv
from web3 import Web3
from eth_account import Account
from eth_account.messages import encode_typed_data

from services.hashing import hash_logs, hash_report

logger = logging.getLogger("tracemind.relayer")

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BACKEND_DIR.parent

load_dotenv(BACKEND_DIR / ".env")

RPC_URL = os.getenv("MST_RPC_URL")
CHAIN_ID = int(os.getenv("MST_CHAIN_ID", "91562037"))

RELAYER_PRIVATE_KEY = os.getenv("MST_RELAYER_PRIVATE_KEY")
FORWARDER_ADDRESS = os.getenv("MST_FORWARDER_ADDRESS")
REGISTRY_ADDRESS = os.getenv("MST_2771_REGISTRY_ADDRESS")

FORWARDER_ABI_PATH = (
    PROJECT_DIR
    / "packages/contracts/artifacts/contracts/TraceMindForwarder.sol/TraceMindForwarder.json"
)

REGISTRY_ABI_PATH = (
    PROJECT_DIR
    / "packages/contracts/artifacts/contracts/EvidenceRegistry2771.sol/EvidenceRegistry2771.json"
)

# Fixed target-call gas limit. Do not accept arbitrary gas limits from clients.
REQUEST_GAS_LIMIT = 300_000
REQUEST_LIFETIME_SECONDS = 600


FORWARD_REQUEST_TYPES = {
    "ForwardRequest": [
        {"name": "from", "type": "address"},
        {"name": "to", "type": "address"},
        {"name": "value", "type": "uint256"},
        {"name": "gas", "type": "uint256"},
        {"name": "nonce", "type": "uint256"},
        {"name": "deadline", "type": "uint48"},
        {"name": "data", "type": "bytes"},
    ]
}


def get_relayer_connection():
    """Connect to MST and load the relayer, forwarder and registry."""

    required = [
        RPC_URL,
        RELAYER_PRIVATE_KEY,
        FORWARDER_ADDRESS,
        REGISTRY_ADDRESS,
    ]

    if not all(required):
        raise RuntimeError(
            "Missing relayer configuration in backend/.env"
        )

    w3 = Web3(
        Web3.HTTPProvider(
            RPC_URL,
            request_kwargs={"timeout": 30},
        )
    )

    if not w3.is_connected():
        raise RuntimeError("Could not connect to MST Testnet")

    if w3.eth.chain_id != CHAIN_ID:
        raise RuntimeError(
            f"Wrong network. Expected {CHAIN_ID}, "
            f"connected to {w3.eth.chain_id}"
        )

    if not FORWARDER_ABI_PATH.exists():
        raise RuntimeError("Forwarder ABI not found. Compile contracts first.")

    if not REGISTRY_ABI_PATH.exists():
        raise RuntimeError("Registry ABI not found. Compile contracts first.")

    with FORWARDER_ABI_PATH.open("r", encoding="utf-8") as file:
        forwarder_artifact = json.load(file)

    with REGISTRY_ABI_PATH.open("r", encoding="utf-8") as file:
        registry_artifact = json.load(file)

    forwarder_address = Web3.to_checksum_address(FORWARDER_ADDRESS)
    registry_address = Web3.to_checksum_address(REGISTRY_ADDRESS)

    if not w3.eth.get_code(forwarder_address):
        raise RuntimeError("No forwarder contract found at configured address")

    if not w3.eth.get_code(registry_address):
        raise RuntimeError("No registry contract found at configured address")

    forwarder = w3.eth.contract(
        address=forwarder_address,
        abi=forwarder_artifact["abi"],
    )

    registry = w3.eth.contract(
        address=registry_address,
        abi=registry_artifact["abi"],
    )

    relayer_account = Account.from_key(RELAYER_PRIVATE_KEY)

    return w3, forwarder, registry, relayer_account


def _hash_to_bytes32(hash_value: str) -> bytes:
    clean_hash = hash_value.removeprefix("0x")

    try:
        result = bytes.fromhex(clean_hash)
    except ValueError as exc:
        raise ValueError("Invalid SHA-256 hash") from exc

    if len(result) != 32:
        raise ValueError("Hash must be exactly 32 bytes")

    return result


def _validate_incident_id(incident_id: str):
    if not incident_id or not incident_id.strip():
        raise ValueError("Incident ID is required")

    if len(incident_id) > 128:
        raise ValueError("Incident ID is too long")


def _build_typed_data(
    sender: str,
    nonce: int,
    deadline: int,
    data: str,
    forwarder_address: str,
) -> dict:
    return {
        "types": FORWARD_REQUEST_TYPES,
        "primaryType": "ForwardRequest",
        "domain": {
            "name": "TraceMindForwarder",
            "version": "1",
            "chainId": CHAIN_ID,
            "verifyingContract": forwarder_address,
        },
        "message": {
            "from": sender,
            "to": Web3.to_checksum_address(REGISTRY_ADDRESS),
            "value": 0,
            "gas": REQUEST_GAS_LIMIT,
            "nonce": nonce,
            "deadline": deadline,
            "data": data,
        },
    }


def prepare_relay_request(
    incident_id: str,
    logs: list[dict],
    report: dict,
    sender: str,
) -> dict:
    """
    Prepare the exact request that MetaMask must sign.

    This endpoint does not send a blockchain transaction.
    """

    _validate_incident_id(incident_id)

    if not Web3.is_address(sender):
        raise ValueError("Invalid MetaMask wallet address")

    sender = Web3.to_checksum_address(sender)

    if not isinstance(logs, list) or not isinstance(report, dict):
        raise ValueError("Invalid logs or report")

    w3, forwarder, registry, _ = get_relayer_connection()

    if registry.functions.exists(incident_id).call():
        raise ValueError("Evidence is already registered for this incident ID")

    log_hash = hash_logs(logs)
    report_hash = hash_report(report)

    log_hash_bytes = _hash_to_bytes32(log_hash)
    report_hash_bytes = _hash_to_bytes32(report_hash)

    register_function = registry.functions.registerEvidence(
        incident_id,
        log_hash_bytes,
        report_hash_bytes,
    )

    # This is the exact calldata that the user authorizes.
    data = register_function._encode_transaction_data()

    nonce = forwarder.functions.nonces(sender).call()
    deadline = int(time.time()) + REQUEST_LIFETIME_SECONDS

    typed_data = _build_typed_data(
        sender=sender,
        nonce=nonce,
        deadline=deadline,
        data=data,
        forwarder_address=forwarder.address,
    )

    return {
        "incident_id": incident_id,
        "log_hash": log_hash,
        "report_hash": report_hash,
        "typed_data": typed_data,
        "request": {
            "from": sender,
            "to": registry.address,
            "value": 0,
            "gas": REQUEST_GAS_LIMIT,
            "nonce": nonce,
            "deadline": deadline,
            "data": data,
        },
        "network": "MST Testnet",
        "chain_id": CHAIN_ID,
        "expires_at": deadline,
    }


def submit_relay_request(
    incident_id: str,
    logs: list[dict],
    report: dict,
    sender: str,
    nonce: int,
    deadline: int,
    signature: str,
) -> dict:
    """
    Validate a MetaMask EIP-712 signature and submit the request
    through the ERC-2771 forwarder using the relayer wallet.
    """

    _validate_incident_id(incident_id)

    if not Web3.is_address(sender):
        raise ValueError("Invalid wallet address")

    sender = Web3.to_checksum_address(sender)

    if not isinstance(logs, list) or not isinstance(report, dict):
        raise ValueError("Invalid logs or report")

    if not isinstance(nonce, int) or nonce < 0:
        raise ValueError("Invalid nonce")

    if not isinstance(deadline, int):
        raise ValueError("Invalid deadline")

    if deadline <= int(time.time()):
        raise ValueError("Signed request has expired")

    if not isinstance(signature, str) or not signature.startswith("0x"):
        raise ValueError("Invalid signature format")

    w3, forwarder, registry, relayer_account = get_relayer_connection()

    if registry.functions.exists(incident_id).call():
        raise ValueError("Evidence is already registered for this incident ID")

    current_nonce = forwarder.functions.nonces(sender).call()

    if current_nonce != nonce:
        raise ValueError("Request nonce is invalid or has already been used")

    log_hash = hash_logs(logs)
    report_hash = hash_report(report)

    log_hash_bytes = _hash_to_bytes32(log_hash)
    report_hash_bytes = _hash_to_bytes32(report_hash)

    register_function = registry.functions.registerEvidence(
        incident_id,
        log_hash_bytes,
        report_hash_bytes,
    )

    data = register_function._encode_transaction_data()

    typed_data = _build_typed_data(
        sender=sender,
        nonce=nonce,
        deadline=deadline,
        data=data,
        forwarder_address=forwarder.address,
    )

    # Recover the wallet that signed the EIP-712 message.
    signable_message = encode_typed_data(full_message=typed_data)

    recovered_address = Account.recover_message(
        signable_message,
        signature=signature,
    )

    if recovered_address.lower() != sender.lower():
        raise ValueError("Signature does not belong to the supplied wallet")

    # OpenZeppelin ForwardRequestData does not contain nonce.
    # The forwarder reads the nonce from its own storage.
    request = (
        sender,
        registry.address,
        0,
        REQUEST_GAS_LIMIT,
        deadline,
        bytes.fromhex(data.removeprefix("0x")),
        bytes.fromhex(signature.removeprefix("0x")),
    )

    # Let the deployed forwarder validate signature, deadline,
    # nonce and whether the target trusts this forwarder.
    if not forwarder.functions.verify(request).call():
        raise ValueError("Forwarder rejected the signed request")

    # Check once more immediately before transaction construction.
    if registry.functions.exists(incident_id).call():
        raise ValueError("Evidence was registered by another request")

    relayer_nonce = w3.eth.get_transaction_count(
        relayer_account.address,
        "pending",
    )

    execute_function = forwarder.functions.execute(request)

    gas_estimate = execute_function.estimate_gas({
        "from": relayer_account.address,
        "value": 0,
    })

    transaction = execute_function.build_transaction({
        "from": relayer_account.address,
        "nonce": relayer_nonce,
        "chainId": CHAIN_ID,
        "gas": int(gas_estimate * 1.25),
        "gasPrice": w3.eth.gas_price,
        "value": 0,
    })

    signed_transaction = relayer_account.sign_transaction(transaction)

    transaction_hash = w3.eth.send_raw_transaction(
        signed_transaction.raw_transaction
    )

    receipt = w3.eth.wait_for_transaction_receipt(
        transaction_hash,
        timeout=120,
    )

    if receipt["status"] != 1:
        raise RuntimeError("Relayed blockchain transaction failed")

    # Confirm the resulting record and actual MetaMask signer.
    stored = registry.functions.getEvidence(incident_id).call()

    if (
        Web3.to_hex(stored[0]).removeprefix("0x").lower()
        != log_hash.lower()
        or Web3.to_hex(stored[1]).removeprefix("0x").lower()
        != report_hash.lower()
        or stored[3].lower() != sender.lower()
    ):
        raise RuntimeError("On-chain evidence confirmation failed")

    return {
        "incident_id": incident_id,
        "registered": True,
        "registered_by": stored[3],
        "log_hash": log_hash,
        "report_hash": report_hash,
        "transaction_hash": transaction_hash.hex(),
        "block_number": receipt["blockNumber"],
        "gas_used": receipt["gasUsed"],
        "relayer_address": relayer_account.address,
        "contract_address": registry.address,
        "forwarder_address": forwarder.address,
        "network": "MST Testnet",
        "method": "ERC-2771 Meta-Transaction",
    }


def verify_relayed_evidence(
    incident_id: str,
    logs: list[dict],
    report: dict,
) -> dict:
    """Verify evidence against the new ERC-2771 registry."""

    _validate_incident_id(incident_id)

    log_hash = hash_logs(logs)
    report_hash = hash_report(report)

    w3, _, registry, _ = get_relayer_connection()

    if not registry.functions.exists(incident_id).call():
        return {
            "incident_id": incident_id,
            "registered": False,
            "verified": False,
            "message": "No evidence is registered for this incident",
        }

    verified = registry.functions.verifyEvidence(
        incident_id,
        _hash_to_bytes32(log_hash),
        _hash_to_bytes32(report_hash),
    ).call()

    stored = registry.functions.getEvidence(incident_id).call()

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
        "contract_address": registry.address,
        "network": "MST Testnet",
    }
