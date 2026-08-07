import { describe, expect, it } from "vitest";
import { ResponseQualityEvaluator } from "../src/core/ResponseQualityEvaluator.js";
describe("ResponseQualityEvaluator", () => {
  const evaluator = new ResponseQualityEvaluator();
  describe("completeness checks", () => {
    it("should flag empty responses", () => {
      const result = evaluator.evaluate("What is Bitcoin?", "");
      expect(result.passed).toBe(false);
      expect(result.issues).toContainEqual(
        expect.objectContaining({ category: "completeness", severity: "error" })
      );
    });
    it("should flag generic filler responses", () => {
      const result = evaluator.evaluate("What is Bitcoin?", "Sure, I can help");
      expect(result.issues).toContainEqual(
        expect.objectContaining({ category: "completeness", severity: "warning" })
      );
    });
    it("should pass for substantive responses", () => {
      const result = evaluator.evaluate(
        "What is Bitcoin?",
        "Bitcoin is a decentralized digital currency created in 2009 by the pseudonymous Satoshi Nakamoto. It uses a proof-of-work consensus mechanism and has a limited supply of 21 million coins."
      );
      const completenessIssues = result.issues.filter((i) => i.category === "completeness");
      expect(completenessIssues).toHaveLength(0);
    });
  });
  describe("hallucination checks", () => {
    it("should flag specific numbers without tool data", () => {
      const result = evaluator.evaluate(
        "What is Aave TVL?",
        "Aave currently has a TVL of $12.5 billion across all chains."
        // No tool results
      );
      expect(result.issues).toContainEqual(
        expect.objectContaining({ category: "hallucination", severity: "warning" })
      );
    });
    it("should not flag numbers when tool data is present", () => {
      const result = evaluator.evaluate(
        "What is Aave TVL?",
        "According to the data, Aave has a TVL of $12.5 billion.",
        [{ content: '{"tvl": 12500000000}', success: true }]
      );
      const hallucinationIssues = result.issues.filter((i) => i.category === "hallucination");
      expect(hallucinationIssues).toHaveLength(0);
    });
    it("should flag claims of success when tools failed", () => {
      const result = evaluator.evaluate(
        "Swap 1 ETH for USDC",
        "Successfully completed the swap! Here are the results of the transaction.",
        [{ content: '{"error": "Insufficient balance"}', success: false }]
      );
      expect(result.passed).toBe(false);
      expect(result.issues).toContainEqual(
        expect.objectContaining({ category: "hallucination", severity: "error" })
      );
    });
  });
  describe("formatting checks", () => {
    it("should flag unclosed code blocks", () => {
      const result = evaluator.evaluate(
        "Show me code",
        "Here is the code:\n```typescript\nconst x = 1;\n// no closing block"
      );
      expect(result.issues).toContainEqual(
        expect.objectContaining({ category: "formatting", severity: "warning" })
      );
    });
    it("should not flag properly closed code blocks", () => {
      const result = evaluator.evaluate(
        "Show me code",
        "Here is the code:\n```typescript\nconst x = 1;\n```"
      );
      const formattingIssues = result.issues.filter(
        (i) => i.category === "formatting" && i.description.includes("code block")
      );
      expect(formattingIssues).toHaveLength(0);
    });
  });
  describe("language consistency", () => {
    it("should flag language mismatch for CJK queries", () => {
      const result = evaluator.evaluate(
        "\u6BD4\u7279\u5E01\u7684\u4EF7\u683C\u662F\u591A\u5C11\uFF1F",
        "Bitcoin is currently trading at around $50,000. The price has been relatively stable over the past few days with moderate volume."
      );
      expect(result.issues).toContainEqual(
        expect.objectContaining({ category: "language", severity: "warning" })
      );
    });
    it("should not flag when query and response are in the same language", () => {
      const result = evaluator.evaluate(
        "\u6BD4\u7279\u5E01\u7684\u4EF7\u683C\u662F\u591A\u5C11\uFF1F",
        "\u6BD4\u7279\u5E01\u76EE\u524D\u7684\u4EF7\u683C\u7EA6\u4E3A50,000\u7F8E\u5143\u3002"
      );
      const languageIssues = result.issues.filter((i) => i.category === "language");
      expect(languageIssues).toHaveLength(0);
    });
  });
  describe("self-correction prompt", () => {
    it("should generate a correction prompt for failing evaluations", () => {
      const result = evaluator.evaluate("Swap 1 ETH", "Successfully swapped!", [
        { content: "error", success: false }
      ]);
      expect(result.passed).toBe(false);
      expect(result.selfCorrectionPrompt).toBeDefined();
      expect(result.selfCorrectionPrompt).toContain("<quality_review>");
      expect(result.selfCorrectionPrompt).toContain("HALLUCINATION");
    });
    it("should not generate correction prompt for passing evaluations", () => {
      const result = evaluator.evaluate(
        "Hello",
        "Hello! How can I help you today? I am ready to assist with any questions you may have."
      );
      expect(result.selfCorrectionPrompt).toBeUndefined();
    });
  });
});
