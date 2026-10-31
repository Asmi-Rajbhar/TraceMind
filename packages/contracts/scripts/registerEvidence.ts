
import hre from "hardhat";
import { createHash } from "node:crypto";

// EvidenceRegistry Contract
const CONTRACT_ADDRESS =
  "0x39cC2195a7c11BC1CD9FBA5792A75464B604Bdd9";

// Use a new ID so we do not overwrite an existing evidence record.
const INCIDENT_ID = "INC-TRACEMIND-DEMO-001";

function sha256(data: string): string {
  return (
    "0x" +
    createHash("sha256").update(data, "utf8").digest("hex")
  );
}

async function main() {
  const [signer] = await hre.ethers.getSigners();

  if (!signer) {
    throw new Error(
      "No signer found. Check PRIVATE_KEY in the repository-root .env.local."
    );
  }

  console.log("Network:", hre.network.name);
  console.log("Wallet:", await signer.getAddress());
  console.log("Contract:", CONTRACT_ADDRESS);

  if (hre.network.name !== "testnet") {
    throw new Error("This script must run on MST Testnet.");
  }

  const code = await hre.ethers.provider.getCode(CONTRACT_ADDRESS);

  if (code === "0x") {
    throw new Error(
      "No contract code found at this address on the selected network."
    );
  }

  const registry = await hre.ethers.getContractAt(
    "EvidenceRegistry",
    CONTRACT_ADDRESS,
    signer
  );

  // Sample checkout-failure logs for our first on-chain demonstration.
  const logs = [
    {
      timestamp: "2026-10-28T10:00:00Z",
      service: "api-gateway",
      level: "INFO",
      trace_id: "trace-101",
      message: "Incoming POST /checkout",
    },
    {
      timestamp: "2026-10-28T10:00:01Z",
      service: "order-service",
      level: "INFO",
      trace_id: "trace-101",
      message: "Order creation started",
    },
    {
      timestamp: "2026-10-28T10:00:02Z",
      service: "payment-service",
      level: "ERROR",
      trace_id: "trace-101",
      message: "Database connection timeout",
    },
    {
      timestamp: "2026-10-28T10:00:03Z",
      service: "order-service",
      level: "ERROR",
      trace_id: "trace-101",
      message: "Payment processing failed",
    },
  ];

  const report = {
    incidentId: INCIDENT_ID,
    title: "Checkout Service Failure",
    severity: "HIGH",
    suspectedRootCause: "Database connection timeout",
    affectedService: "payment-service",
    confidenceType: "heuristic",
  };

  // Hash the exact strings that we register.
  const logsJson = JSON.stringify(logs);
  const reportJson = JSON.stringify(report);

  const logHash = sha256(logsJson);
  const reportHash = sha256(reportJson);

  console.log("\nLog SHA-256:", logHash);
  console.log("Report SHA-256:", reportHash);

  // Prevent a confusing duplicate-registration revert.
  const alreadyExists = await registry.exists(INCIDENT_ID);

  if (alreadyExists) {
    console.log(
      `\n${INCIDENT_ID} is already registered. Choose a new incident ID ` +
      "or verify the existing record; do not redeploy the contract."
    );
    return;
  }

  console.log("\nSubmitting registration transaction...");

  const tx = await registry.registerEvidence(
    INCIDENT_ID,
    logHash,
    reportHash
  );

  console.log("Transaction submitted:", tx.hash);

  const receipt = await tx.wait();

  if (!receipt || receipt.status !== 1) {
    throw new Error("Evidence registration transaction failed.");
  }

  console.log("Registration confirmed!");
  console.log("Block number:", receipt.blockNumber);
  console.log("Transaction hash:", receipt.hash);

  // Verify the original hashes.
  const originalMatches = await registry.verifyEvidence(
    INCIDENT_ID,
    logHash,
    reportHash
  );

  console.log("Original evidence matches:", originalMatches);

  // Change one log message and calculate its new SHA-256 hash.
  const modifiedLogs = logs.map((log, index) =>
    index === 2
      ? { ...log, message: "Database working normally" }
      : log
  );

  const modifiedLogHash = sha256(JSON.stringify(modifiedLogs));

  const modifiedMatches = await registry.verifyEvidence(
    INCIDENT_ID,
    modifiedLogHash,
    reportHash
  );

  console.log("Modified evidence matches:", modifiedMatches);

  if (!originalMatches || modifiedMatches) {
    throw new Error("Evidence verification returned an unexpected result.");
  }

  console.log("\nSUCCESS: TraceMind evidence verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});


// What this code does
// 1. Connects to your configured MST Testnet using the wallet loaded by Hardhat.
// 2. Checks that code exists at your deployed contract address.
// 3. Creates sample checkout logs and a corresponding investigation report.
// 4. Calculates SHA-256 hashes for both.
// 5. Registers them using a real blockchain transaction.
// 6. Waits for transaction confirmation.
// 7. Checks the original hashes and a modified version against the contract.