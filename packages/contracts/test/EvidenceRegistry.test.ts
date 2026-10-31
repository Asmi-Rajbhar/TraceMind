
import { ethers } from "hardhat";
import { expect } from "chai";

describe("EvidenceRegistry", function () {
  async function deployRegistry() {
    const registry = await ethers.deployContract("EvidenceRegistry");
    await registry.waitForDeployment();
    return registry;
  }

  const incidentId = "INC-001";

  // Test values only; these are not production evidence hashes.
  const logHash = ethers.id("original checkout logs");
  const reportHash = ethers.id("original investigation report");

  it("registers and retrieves evidence", async function () {
    const registry = await deployRegistry();

    await registry.registerEvidence(
      incidentId,
      logHash,
      reportHash
    );

    expect(await registry.exists(incidentId)).to.equal(true);

    const record = await registry.getEvidence(incidentId);

    expect(record.logHash).to.equal(logHash);
    expect(record.reportHash).to.equal(reportHash);
  });

  it("accepts matching evidence", async function () {
    const registry = await deployRegistry();

    await registry.registerEvidence(
      incidentId,
      logHash,
      reportHash
    );

    expect(
      await registry.verifyEvidence(
        incidentId,
        logHash,
        reportHash
      )
    ).to.equal(true);
  });

  it("rejects changed log evidence", async function () {
    const registry = await deployRegistry();

    await registry.registerEvidence(
      incidentId,
      logHash,
      reportHash
    );

    const changedLogHash = ethers.id("modified checkout logs");

    expect(
      await registry.verifyEvidence(
        incidentId,
        changedLogHash,
        reportHash
      )
    ).to.equal(false);
  });

  it("rejects changed report evidence", async function () {
    const registry = await deployRegistry();

    await registry.registerEvidence(
      incidentId,
      logHash,
      reportHash
    );

    const changedReportHash = ethers.id("modified investigation report");

    expect(
      await registry.verifyEvidence(
        incidentId,
        logHash,
        changedReportHash
      )
    ).to.equal(false);
  });

  it("returns false for an unknown incident", async function () {
    const registry = await deployRegistry();

    expect(
      await registry.verifyEvidence(
        "INC-UNKNOWN",
        logHash,
        reportHash
      )
    ).to.equal(false);
  });

  it("prevents registering the same incident twice", async function () {
    const registry = await deployRegistry();

    await registry.registerEvidence(
      incidentId,
      logHash,
      reportHash
    );

    await expect(
      registry.registerEvidence(
        incidentId,
        logHash,
        reportHash
      )
    ).to.be.revertedWith("Evidence already registered");
  });
});
