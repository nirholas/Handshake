// Probe AgenC devnet state so the roundtrip example knows the real
// preconditions (protocol initialized? minimum stake? rate limits?).
// Run once during integration work; not part of the published surface.
import { createAgenCClient } from "../dist/index.js";
import { getProtocolConfig, getZkConfig } from "@tetsuo-ai/sdk";

const client = createAgenCClient({ cluster: "devnet" });
console.log("rpc:", client.connection.rpcEndpoint);
console.log("programId:", client.programId.toBase58());

const protocol = await getProtocolConfig(client.program);
console.log("protocol:", protocol ? JSON.parse(JSON.stringify(protocol, (_, v) =>
  typeof v === "bigint" ? v.toString() : v?.toBase58?.() ?? v,
)) : null);

const zk = await getZkConfig(client.program);
console.log("zkConfig:", zk ? JSON.parse(JSON.stringify(zk, (_, v) =>
  typeof v === "bigint" ? v.toString() : v?.toBase58?.() ?? v,
)) : null);
