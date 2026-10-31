
import hre from "hardhat";
import promptSyncFactory from "prompt-sync";
import { deployAll } from "../deploy.config";
import { writeDeploymentAddresses } from "./lib/writeDeployment";

async function main() {
  const network = hre.network.name;

  if (!process.env.PRIVATE_KEY) {
    throw new Error(
      "PRIVATE_KEY not set. Check your root .env.local file."
    );
  }

  if (network === "mainnet") {
    console.log("\nWARNING: DEPLOYING TO MAINNET");
    console.log(`Chain ID: ${hre.network.config.chainId}\n`);

    const promptSync = promptSyncFactory({ sigint: true });

    const confirm = promptSync(
      "Type 'yes, deploy to mainnet' to continue: "
    );

    if (confirm !== "yes, deploy to mainnet") {
      throw new Error("Deployment cancelled.");
    }
  }

  console.log(`\nDeploying TraceMind contracts to ${network}...\n`);

  const results = await deployAll(hre);

  const deployed: Record<
    string,
    {
      address: string;
      abi: unknown;
      constructorArguments: unknown[];
    }
  > = {};

  for (const [name, result] of Object.entries(results)) {
    const artifact = await hre.artifacts.readArtifact(name);

    deployed[name] = {
      address: result.address,
      abi: artifact.abi,
      constructorArguments: result.constructorArguments,
    };
  }

  writeDeploymentAddresses(network, deployed);

  console.log("\nDeployment successful!\n");

  for (const [name, contract] of Object.entries(deployed)) {
    console.log(`${name}: ${contract.address}`);
  }

  console.log(
    "\nAddresses and ABIs written to packages/shared/src/contracts.ts"
  );

  if (network !== "hardhat" && network !== "localhost") {
    console.log(`\nNext: npm run verify:${network}\n`);
  }
}

main().catch((error) => {
  console.error("\nDeployment failed:");
  console.error(error);
  process.exitCode = 1;
});
