
import type { HardhatRuntimeEnvironment } from "hardhat/types";

export async function deployAll(hre: HardhatRuntimeEnvironment) {
  // 1. Deploy ERC-2771 Forwarder
  const ForwarderFactory = await hre.ethers.getContractFactory(
    "TraceMindForwarder"
  );

  const forwarder = await ForwarderFactory.deploy();
  await forwarder.waitForDeployment();

  const forwarderAddress = await forwarder.getAddress();

  console.log("TraceMindForwarder deployed:", forwarderAddress);

  // 2. Deploy EvidenceRegistry with the forwarder as trusted forwarder
  const RegistryFactory = await hre.ethers.getContractFactory(
    "EvidenceRegistry2771"
  );

  const registry = await RegistryFactory.deploy(forwarderAddress);
  await registry.waitForDeployment();

  const registryAddress = await registry.getAddress();

  console.log("EvidenceRegistry2771 deployed:", registryAddress);

  return {
    TraceMindForwarder: {
      address: forwarderAddress,
      constructorArguments: [],
    },

    EvidenceRegistry2771: {
      address: registryAddress,
      constructorArguments: [forwarderAddress],
    },
  };
}
