import { describe, expect, it } from "vitest";
import { ToolRelevanceScorer } from "../src/core/ToolRelevanceScorer.js";
const createManifest = (identifier, description, apis = []) => ({
  api: apis,
  description,
  identifier
});
describe("ToolRelevanceScorer", () => {
  it("should return all tools when query is empty or too generic", () => {
    const scorer = new ToolRelevanceScorer({ maxTools: 20 });
    const manifests = {
      "tool-a": createManifest("tool-a", "Does something"),
      "tool-b": createManifest("tool-b", "Does something else")
    };
    expect(scorer.scoreTools("", manifests)).toHaveLength(2);
    expect(scorer.scoreTools("a", manifests)).toHaveLength(2);
  });
  it("should rank tools by relevance to query keywords", () => {
    const scorer = new ToolRelevanceScorer({ maxTools: 5 });
    const manifests = {
      "defi-analytics": createManifest("defi-analytics", "Analyze DeFi protocols and TVL data", [
        { description: "Get protocol TVL", name: "getProtocolTVL" }
      ]),
      "knowledge-base": createManifest("knowledge-base", "Search knowledge documents", [
        { description: "Search documents", name: "searchDocuments" }
      ]),
      "memory": createManifest("memory", "Store and recall user memories", [
        { description: "Search user memory", name: "searchUserMemory" }
      ]),
      "swap": createManifest("swap", "Execute token swaps via DEX aggregators", [
        { description: "Swap tokens", name: "swapTokens" }
      ])
    };
    const result = scorer.scoreTools("what is the TVL of Aave DeFi protocol", manifests);
    expect(result[0].identifier).toBe("defi-analytics");
  });
  it("should always include tools from alwaysIncludeTools list", () => {
    const scorer = new ToolRelevanceScorer({
      alwaysIncludeTools: ["memory"],
      maxTools: 2
    });
    const manifests = {
      "defi-analytics": createManifest("defi-analytics", "Analyze DeFi metrics"),
      "memory": createManifest("memory", "Store memories"),
      "swap": createManifest("swap", "Swap tokens")
    };
    const result = scorer.scoreTools("swap ETH for USDC", manifests);
    const identifiers = result.map((m) => m.identifier);
    expect(identifiers).toContain("memory");
    expect(result.length).toBeLessThanOrEqual(2);
  });
  it("should boost recently-used tools", () => {
    const scorer = new ToolRelevanceScorer({ maxTools: 5, recencyBoost: 3 });
    const manifests = {
      "markets": createManifest("markets", "Market data and prices"),
      "swap": createManifest("swap", "Swap tokens on exchanges")
    };
    const withoutRecency = scorer.scoreTools("check prices", manifests, []);
    const withRecency = scorer.scoreTools("check prices", manifests, ["swap"]);
    const swapIndexWithout = withoutRecency.findIndex((m) => m.identifier === "swap");
    const swapIndexWith = withRecency.findIndex((m) => m.identifier === "swap");
    expect(swapIndexWith).toBeLessThanOrEqual(swapIndexWithout);
  });
  it("should filter tools below minScore threshold", () => {
    const scorer = new ToolRelevanceScorer({ maxTools: 10, minScore: 1 });
    const manifests = {
      "contract-explorer": createManifest("contract-explorer", "Explore smart contracts"),
      "swap": createManifest("swap", "Swap tokens"),
      "weather": createManifest("weather", "Get weather data")
    };
    const result = scorer.scoreTools("swap tokens please", manifests);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].identifier).toBe("swap");
  });
  it("should match against API names and descriptions", () => {
    const scorer = new ToolRelevanceScorer({ maxTools: 5 });
    const manifests = {
      "coingecko": createManifest("coingecko", "CoinGecko data provider", [
        { description: "Get token reputation and trust score", name: "getTokenReputation" }
      ]),
      "erc8004": createManifest("erc8004", "Agent registry protocol", [
        { description: "Get agent reputation score", name: "getReputation" }
      ])
    };
    const result = scorer.scoreTools("check reputation score", manifests);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const identifiers = result.map((m) => m.identifier);
    expect(identifiers).toContain("erc8004");
  });
});
