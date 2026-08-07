import { describe, expect, it } from "vitest";
import { SelfReflection } from "../src/core/SelfReflection.js";
describe("SelfReflection", () => {
  describe("classifyError", () => {
    it("should classify invalid argument errors", () => {
      const sr = new SelfReflection();
      expect(sr.classifyError("Invalid argument: expected number got string")).toBe(
        "invalid_arguments"
      );
      expect(sr.classifyError('Validation failed for field "amount"')).toBe("invalid_arguments");
      expect(sr.classifyError("Schema mismatch")).toBe("invalid_arguments");
    });
    it("should classify missing field errors", () => {
      const sr = new SelfReflection();
      expect(sr.classifyError('Required field "address" is missing')).toBe(
        "missing_required_field"
      );
      expect(sr.classifyError('Parameter "chainId" is undefined')).toBe("missing_required_field");
    });
    it("should classify rate limit errors", () => {
      const sr = new SelfReflection();
      expect(sr.classifyError("429 Too Many Requests")).toBe("api_rate_limit");
      expect(sr.classifyError("Rate limit exceeded, retry after 60s")).toBe("api_rate_limit");
    });
    it("should classify network errors", () => {
      const sr = new SelfReflection();
      expect(sr.classifyError("ECONNREFUSED 127.0.0.1:5432")).toBe("network_error");
      expect(sr.classifyError("fetch failed: DNS resolution error")).toBe("network_error");
    });
    it("should classify permission errors", () => {
      const sr = new SelfReflection();
      expect(sr.classifyError("403 Forbidden")).toBe("permission_denied");
      expect(sr.classifyError("Unauthorized: invalid API key")).toBe("permission_denied");
    });
    it("should classify not found errors", () => {
      const sr = new SelfReflection();
      expect(sr.classifyError("404 Not Found")).toBe("not_found");
      expect(sr.classifyError("No results found for query")).toBe("not_found");
    });
    it("should classify timeout errors", () => {
      const sr = new SelfReflection();
      expect(sr.classifyError("Request timed out after 10000ms")).toBe("timeout");
      expect(sr.classifyError("Deadline exceeded")).toBe("timeout");
    });
    it("should return unknown for unclassifiable errors", () => {
      const sr = new SelfReflection();
      expect(sr.classifyError("Something completely unexpected happened")).toBe("unknown");
    });
  });
  describe("generateCorrectionPrompt", () => {
    it("should generate a structured correction prompt", () => {
      const sr = new SelfReflection();
      const prompt = sr.generateCorrectionPrompt({
        apiName: "getTokenPrice",
        arguments: '{"token": "ETH"}',
        error: 'Required field "chainId" is missing',
        retryCount: 0,
        toolIdentifier: "coingecko"
      });
      expect(prompt).toContain("<tool_error_analysis>");
      expect(prompt).toContain("coingecko/getTokenPrice");
      expect(prompt).toContain("missing_required_field");
      expect(prompt).toContain("Attempt: 1/2");
      expect(prompt).toContain("</tool_error_analysis>");
    });
    it("should include last-retry warning on final attempt", () => {
      const sr = new SelfReflection({ maxRetries: 2 });
      const prompt = sr.generateCorrectionPrompt({
        apiName: "swap",
        arguments: "{}",
        error: "Invalid argument",
        retryCount: 1,
        toolIdentifier: "swap"
      });
      expect(prompt).toContain("last retry attempt");
      expect(prompt).toContain("different tool");
    });
  });
  describe("trackRetry", () => {
    it("should allow retries up to maxRetries", () => {
      const sr = new SelfReflection({ maxRetries: 2 });
      expect(sr.trackRetry("call-1")).toBe(true);
      expect(sr.trackRetry("call-1")).toBe(true);
      expect(sr.trackRetry("call-1")).toBe(false);
    });
    it("should track retries independently per tool call", () => {
      const sr = new SelfReflection({ maxRetries: 1 });
      expect(sr.trackRetry("call-1")).toBe(true);
      expect(sr.trackRetry("call-1")).toBe(false);
      expect(sr.trackRetry("call-2")).toBe(true);
    });
  });
  describe("shouldRetry", () => {
    it("should not retry permission errors", () => {
      const sr = new SelfReflection();
      expect(sr.shouldRetry("403 Forbidden")).toBe(false);
    });
    it("should not retry rate limit errors", () => {
      const sr = new SelfReflection();
      expect(sr.shouldRetry("429 Too Many Requests")).toBe(false);
    });
    it("should retry network errors", () => {
      const sr = new SelfReflection();
      expect(sr.shouldRetry("ECONNREFUSED")).toBe(true);
    });
    it("should retry invalid argument errors", () => {
      const sr = new SelfReflection();
      expect(sr.shouldRetry("Invalid argument: expected number")).toBe(true);
    });
  });
  describe("reset", () => {
    it("should clear all retry tracking", () => {
      const sr = new SelfReflection({ maxRetries: 1 });
      sr.trackRetry("call-1");
      expect(sr.trackRetry("call-1")).toBe(false);
      sr.reset();
      expect(sr.trackRetry("call-1")).toBe(true);
    });
  });
});
