import { createConfig, http } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { mstMainnet, mstTestnet } from "./chains";

const walletConnectProjectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

export const wagmiConfig = createConfig({
  chains: [mstTestnet, mstMainnet],

  connectors: [
    injected({
      target: "metaMask",
    }),

    ...(walletConnectProjectId
      ? [walletConnect({ projectId: walletConnectProjectId })]
      : []),
  ],

  transports: {
    [mstTestnet.id]: http("/api/rpc/testnet"),
    [mstMainnet.id]: http("/api/rpc/mainnet"),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}