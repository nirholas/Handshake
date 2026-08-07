import { describe, expect, it } from "vitest";
import { ImportanceScorer } from "../src/utils/importanceScorer.js";
describe("ImportanceScorer", () => {
  const createMessage = (role, content, extra) => ({
    content,
    role,
    ...extra
  });
  describe("scoreMessages", () => {
    it("should score system messages at maximum importance", () => {
      const scorer = new ImportanceScorer();
      const messages = [
        createMessage("system", "You are a helpful assistant"),
        createMessage("user", "Hello")
      ];
      const scored = scorer.scoreMessages(messages);
      expect(scored[0].score).toBe(1);
    });
    it("should score pinned messages at maximum importance", () => {
      const scorer = new ImportanceScorer();
      const messages = [
        createMessage("user", "Important context", { metadata: { pinned: true } }),
        createMessage("assistant", "Got it")
      ];
      const scored = scorer.scoreMessages(messages);
      expect(scored[0].score).toBe(1);
    });
    it("should score recent messages higher than old ones", () => {
      const scorer = new ImportanceScorer();
      const messages = [
        createMessage("user", "Old message"),
        createMessage("assistant", "Old response with some significant content and detail"),
        createMessage("user", "Recent message"),
        createMessage("assistant", "Recent response with some significant content and detail")
      ];
      const scored = scorer.scoreMessages(messages);
      expect(scored[2].score).toBeGreaterThan(scored[0].score);
      expect(scored[3].score).toBeGreaterThan(scored[1].score);
    });
    it("should boost messages semantically relevant to the current query", () => {
      const scorer = new ImportanceScorer();
      const messages = [
        createMessage("user", "What is the TVL of Aave?"),
        createMessage("assistant", "Aave has a TVL of $10B across all chains."),
        createMessage("user", "What about Uniswap?"),
        createMessage("assistant", "Uniswap has $5B TVL.")
      ];
      const scored = scorer.scoreMessages(messages, "Tell me more about Aave TVL");
      expect(scored[0].score).toBeGreaterThan(0);
      expect(scored[1].score).toBeGreaterThan(0);
    });
    it("should score user messages higher than assistant messages", () => {
      const scorer = new ImportanceScorer();
      const messages = [
        createMessage("user", "A short question"),
        createMessage("assistant", "A short reply")
      ];
      const scored = scorer.scoreMessages(messages);
      const userScore = scored[0].score;
      const assistantScore = scored[1].score;
      expect(userScore).toBeGreaterThanOrEqual(assistantScore);
    });
  });
  describe("partitionForCompression", () => {
    it("should always keep recent messages", () => {
      const scorer = new ImportanceScorer({ keepRecentCount: 2 });
      const messages = Array.from(
        { length: 10 },
        (_, i) => createMessage("user", `Message ${i}: ${"x".repeat(100)}`)
      );
      const scored = scorer.scoreMessages(messages);
      const { toKeep } = scorer.partitionForCompression(scored, 500);
      const keptIndices = toKeep.map((item) => scored.indexOf(item));
      expect(keptIndices).toContain(8);
      expect(keptIndices).toContain(9);
    });
    it("should always keep pinned messages", () => {
      const scorer = new ImportanceScorer({ keepRecentCount: 1 });
      const messages = [
        createMessage("user", "Important context", { metadata: { pinned: true } }),
        createMessage("assistant", "Response 1"),
        createMessage("user", "Later message")
      ];
      const scored = scorer.scoreMessages(messages);
      const { toKeep } = scorer.partitionForCompression(scored, 500);
      expect(toKeep.some((item) => item.message.content === "Important context")).toBe(true);
    });
    it("should compress low-importance messages when budget is tight", () => {
      const scorer = new ImportanceScorer({ keepRecentCount: 2 });
      const messages = [
        createMessage("user", "Old question about weather"),
        createMessage("assistant", "It is sunny today."),
        createMessage("user", "What about crypto?"),
        createMessage("assistant", "Bitcoin is at $50k.")
      ];
      const scored = scorer.scoreMessages(messages);
      const { toCompress, toKeep } = scorer.partitionForCompression(scored, 50);
      expect(toKeep.length).toBeGreaterThanOrEqual(2);
      expect(toCompress.length + toKeep.length).toBe(messages.length);
    });
  });
});
