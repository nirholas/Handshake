import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockBuildAndSendFn = jest.fn<(...args: any[]) => Promise<string>>();

jest.unstable_mockModule("../src/tx/build.js", () => ({
  buildAndSend: mockBuildAndSendFn,
}));

const { SolanaAgent } = await import("../src/agent.js");
const { KeypairWalletProvider } = await import("../src/wallet/keypair.js");
const { BrowserWalletProvider } = await import("../src/wallet/browser-server.js");
const { Keypair, SystemInstruction } =
  await import("@solana/web3.js") as typeof import("@solana/web3.js");

const KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(7));
const RECIPIENT = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey;
const RPC_URL = "https://api.mainnet-beta.solana.com";

beforeEach(() => {
  jest.clearAllMocks();
  mockBuildAndSendFn.mockResolvedValue("agentSig");
});

describe("SolanaAgent.fromKeypair", () => {
  it("builds an agent whose publicKey matches the keypair", () => {
    const agent = SolanaAgent.fromKeypair(KEYPAIR.secretKey, RPC_URL);
    expect(agent.publicKey.equals(KEYPAIR.publicKey)).toBe(true);
  });

  it("wraps the key in a KeypairWalletProvider and connects to the given RPC", () => {
    const agent = SolanaAgent.fromKeypair(KEYPAIR.secretKey, RPC_URL);
    expect(agent.wallet).toBeInstanceOf(KeypairWalletProvider);
    expect(agent.connection.rpcEndpoint).toBe(RPC_URL);
  });

  it("accepts the secret key as number[]", () => {
    const agent = SolanaAgent.fromKeypair(Array.from(KEYPAIR.secretKey), RPC_URL);
    expect(agent.publicKey.equals(KEYPAIR.publicKey)).toBe(true);
  });
});

describe("SolanaAgent.fromBrowserWallet", () => {
  it("returns both the agent and the BrowserWalletProvider, sharing one publicKey", () => {
    const { agent, walletProvider } = SolanaAgent.fromBrowserWallet(KEYPAIR.publicKey, RPC_URL);
    expect(walletProvider).toBeInstanceOf(BrowserWalletProvider);
    expect(agent.wallet).toBe(walletProvider);
    expect(agent.publicKey.equals(KEYPAIR.publicKey)).toBe(true);
  });
});

describe("SolanaAgent action delegation", () => {
  it("transferSol signs with the agent wallet and targets the recipient", async () => {
    const agent = SolanaAgent.fromKeypair(KEYPAIR.secretKey, RPC_URL);
    const sig = await agent.transferSol(RECIPIENT, 0.25);

    expect(sig).toBe("agentSig");
    const [wallet, connection, instructions] = mockBuildAndSendFn.mock.calls[0]!;
    expect(wallet).toBe(agent.wallet);
    expect(connection).toBe(agent.connection);
    const decoded = SystemInstruction.decodeTransfer(instructions[0]!);
    expect(decoded.fromPubkey.equals(KEYPAIR.publicKey)).toBe(true);
    expect(decoded.toPubkey.equals(RECIPIENT)).toBe(true);
  });

  it("getBalance queries the connection for the wallet's own address", async () => {
    const agent = SolanaAgent.fromKeypair(KEYPAIR.secretKey, RPC_URL);
    const getBalance = jest.fn<(...args: any[]) => Promise<number>>().mockResolvedValue(42);
    (agent.connection as any).getBalance = getBalance;

    await expect(agent.getBalance()).resolves.toBe(42);
    expect((getBalance.mock.calls[0]![0] as any).equals(KEYPAIR.publicKey)).toBe(true);
  });
});
