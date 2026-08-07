import { describe, expect, it, vi } from "vitest";
import { CapabilityGuard } from "../src/core/CapabilityGuard.js";
function makeState(overrides) {
  return {
    error: null,
    lastModified: (/* @__PURE__ */ new Date()).toISOString(),
    messages: [],
    metadata: { agentId: "agent-001" },
    status: "running",
    ...overrides
  };
}
function makeCallToolInstruction(toolName, args = {}) {
  return {
    payload: {
      toolCalling: {
        apiName: toolName,
        arguments: JSON.stringify(args),
        id: "tool-call-123"
      }
    },
    type: "call_tool"
  };
}
function makeNonToolInstruction() {
  return {
    payload: { messages: [] },
    type: "call_llm"
  };
}
describe("CapabilityGuard", () => {
  describe("wrap", () => {
    it("should pass through non-call_tool instructions", async () => {
      const check = vi.fn();
      const guard = new CapabilityGuard(check);
      const innerExecutor = vi.fn().mockResolvedValue({
        events: [],
        newState: makeState()
      });
      const wrapped = guard.wrap(innerExecutor);
      const instruction = makeNonToolInstruction();
      const state = makeState();
      await wrapped(instruction, state);
      expect(check).not.toHaveBeenCalled();
      expect(innerExecutor).toHaveBeenCalledWith(instruction, state, void 0);
    });
    it("should allow tool call when capability check passes", async () => {
      const check = vi.fn().mockResolvedValue({
        allowed: true,
        tokenId: "ctk_abc"
      });
      const guard = new CapabilityGuard(check);
      const innerResult = { events: [{ type: "tool_result" }], newState: makeState() };
      const innerExecutor = vi.fn().mockResolvedValue(innerResult);
      const wrapped = guard.wrap(innerExecutor);
      const instruction = makeCallToolInstruction("swap", { amount: 100 });
      const state = makeState();
      const result = await wrapped(instruction, state);
      expect(check).toHaveBeenCalledWith({
        agentId: "agent-001",
        args: { amount: 100 },
        toolName: "swap"
      });
      expect(innerExecutor).toHaveBeenCalled();
      expect(result).toBe(innerResult);
    });
    it("should block tool call when capability check fails", async () => {
      const check = vi.fn().mockResolvedValue({
        allowed: false,
        reason: "No valid token for tool:swap"
      });
      const guard = new CapabilityGuard(check);
      const innerExecutor = vi.fn();
      const wrapped = guard.wrap(innerExecutor);
      const instruction = makeCallToolInstruction("swap", { amount: 100 });
      const state = makeState();
      const result = await wrapped(instruction, state);
      expect(innerExecutor).not.toHaveBeenCalled();
      expect(result.events).toHaveLength(1);
      expect(result.events[0].result.blocked).toBe(true);
      const lastMessage = result.newState.messages.at(-1);
      expect(lastMessage?.role).toBe("tool");
      const content = JSON.parse(lastMessage?.content);
      expect(content.error).toBe("Capability denied");
      expect(content.reason).toBe("No valid token for tool:swap");
    });
    it("should use default reason when none provided", async () => {
      const check = vi.fn().mockResolvedValue({
        allowed: false
      });
      const guard = new CapabilityGuard(check);
      const innerExecutor = vi.fn();
      const wrapped = guard.wrap(innerExecutor);
      const result = await wrapped(
        makeCallToolInstruction("bridge"),
        makeState()
      );
      const content = JSON.parse(result.newState.messages.at(-1)?.content);
      expect(content.reason).toBe("No valid capability token for this action.");
    });
    it("should handle missing toolCalling payload gracefully", async () => {
      const check = vi.fn();
      const guard = new CapabilityGuard(check);
      const innerExecutor = vi.fn().mockResolvedValue({
        events: [],
        newState: makeState()
      });
      const wrapped = guard.wrap(innerExecutor);
      const instruction = { payload: {}, type: "call_tool" };
      await wrapped(instruction, makeState());
      expect(check).not.toHaveBeenCalled();
      expect(innerExecutor).toHaveBeenCalled();
    });
    it("should handle invalid JSON arguments", async () => {
      const check = vi.fn().mockResolvedValue({
        allowed: true
      });
      const guard = new CapabilityGuard(check);
      const innerExecutor = vi.fn().mockResolvedValue({
        events: [],
        newState: makeState()
      });
      const wrapped = guard.wrap(innerExecutor);
      const instruction = {
        payload: {
          toolCalling: {
            apiName: "swap",
            arguments: "not-valid-json{{{",
            id: "tool-42"
          }
        },
        type: "call_tool"
      };
      await wrapped(instruction, makeState());
      expect(check).toHaveBeenCalledWith(
        expect.objectContaining({ args: {} })
      );
    });
    it('should use "unknown" agentId when not set in metadata', async () => {
      const check = vi.fn().mockResolvedValue({
        allowed: true
      });
      const guard = new CapabilityGuard(check);
      const innerExecutor = vi.fn().mockResolvedValue({
        events: [],
        newState: makeState()
      });
      const wrapped = guard.wrap(innerExecutor);
      const state = makeState({ metadata: {} });
      await wrapped(makeCallToolInstruction("test"), state);
      expect(check).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "unknown" })
      );
    });
    it("should pass context through to inner executor", async () => {
      const check = vi.fn().mockResolvedValue({
        allowed: true
      });
      const guard = new CapabilityGuard(check);
      const innerExecutor = vi.fn().mockResolvedValue({
        events: [],
        newState: makeState()
      });
      const wrapped = guard.wrap(innerExecutor);
      const context = { phase: "tool_result" };
      await wrapped(makeCallToolInstruction("test"), makeState(), context);
      expect(innerExecutor).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        context
      );
    });
  });
});
