import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../src/core/runtime.js";
class MockAgent {
  tools = {};
  executors = {};
  modelRuntime;
  async runner(context, state) {
    switch (context.phase) {
      case "user_input":
        return { type: "call_llm", payload: { messages: state.messages } };
      case "llm_result":
        const llmPayload = context.payload;
        if (llmPayload.hasToolCalls) {
          return {
            type: "request_human_approve",
            pendingToolsCalling: llmPayload.result.tool_calls
          };
        }
        return { type: "finish", reason: "completed", reasonDetail: "Done" };
      case "tool_result":
        return { type: "call_llm", payload: { messages: state.messages } };
      default:
        return { type: "finish", reason: "completed", reasonDetail: "Done" };
    }
  }
}
function createTestContext(phase, payload, operationId = "test-session") {
  return {
    phase,
    payload,
    session: {
      // Note: AgentRuntimeContext.session uses sessionId for backward compatibility
      sessionId: operationId,
      messageCount: 1,
      status: "idle",
      stepCount: 0
    }
  };
}
describe("AgentRuntime", () => {
  describe("Constructor and Executor Priority", () => {
    it("should use built-in executors by default", () => {
      const agent = new MockAgent();
      const runtime = new AgentRuntime(agent);
      const executors = runtime.executors;
      expect(executors).toHaveProperty("call_llm");
      expect(executors).toHaveProperty("call_tool");
      expect(executors).toHaveProperty("finish");
      expect(executors).toHaveProperty("request_human_approve");
    });
    it("should allow config executors to override built-in ones", () => {
      const agent = new MockAgent();
      const customFinish = vi.fn();
      const config = {
        executors: {
          finish: customFinish
        }
      };
      const runtime = new AgentRuntime(agent, config);
      expect(runtime.executors.finish).toBe(customFinish);
    });
    it("should give agent executors highest priority", () => {
      const agent = new MockAgent();
      const agentFinish = vi.fn();
      const configFinish = vi.fn();
      agent.executors = { finish: agentFinish };
      const config = {
        executors: { finish: configFinish }
      };
      const runtime = new AgentRuntime(agent, config);
      expect(runtime.executors.finish).toBe(agentFinish);
    });
  });
  describe("step method", () => {
    it("should execute approved tool call directly", async () => {
      const agent = new MockAgent();
      agent.tools = {
        test_tool: vi.fn().mockResolvedValue({ result: "success" })
      };
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({ operationId: "test-session" });
      const toolCall = {
        id: "call_123",
        apiName: "test_tool",
        identifier: "test_tool",
        arguments: '{"input": "test"}',
        type: "default"
      };
      const result = await runtime.approveToolCall(state, toolCall);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        type: "tool_result",
        id: "call_123",
        result: { result: "success" }
      });
      expect(result.newState.messages).toHaveLength(1);
      expect(result.newState.messages[0].role).toBe("tool");
    });
    it("should follow agent runner -> executor flow", async () => {
      const agent = new MockAgent();
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({
        operationId: "test-session",
        messages: [{ role: "user", content: "Hello" }]
      });
      const result = await runtime.step(state);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe("error");
      expect(result.newState.status).toBe("error");
    });
    it("should handle errors gracefully", async () => {
      const agent = new MockAgent();
      agent.runner = vi.fn().mockImplementation(() => Promise.reject(new Error("Agent error")));
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({ operationId: "test-session" });
      const result = await runtime.step(state);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        type: "error",
        error: expect.any(Error)
      });
      expect(result.newState.status).toBe("error");
      expect(result.newState.error).toBeInstanceOf(Error);
    });
  });
  describe("Built-in Executors", () => {
    describe("call_llm executor", () => {
      it("should require modelRuntime", async () => {
        const agent = new MockAgent();
        const runtime = new AgentRuntime(agent);
        const state = AgentRuntime.createInitialState({
          operationId: "test-session",
          messages: [{ role: "user", content: "Hello" }]
        });
        const result = await runtime.step(state);
        expect(result.events[0].type).toBe("error");
        expect(result.events[0].error.message).toContain(
          "Model Runtime is required"
        );
      });
      it("should handle streaming LLM response", async () => {
        const agent = new MockAgent();
        async function* mockModelRuntime(payload) {
          yield { content: "Hello" };
          yield { content: " world" };
          yield { content: "!" };
        }
        agent.modelRuntime = mockModelRuntime;
        const runtime = new AgentRuntime(agent);
        const state = AgentRuntime.createInitialState({
          operationId: "test-session",
          messages: [{ role: "user", content: "Hello" }]
        });
        const result = await runtime.step(state);
        expect(result.events).toHaveLength(5);
        expect(result.events[0]).toMatchObject({
          type: "llm_start",
          payload: expect.anything()
        });
        expect(result.events[1]).toMatchObject({
          type: "llm_stream",
          chunk: { content: "Hello" }
        });
        expect(result.events[4]).toMatchObject({
          type: "llm_result",
          result: { content: "Hello world!", tool_calls: [] }
        });
        expect(result.newState.messages).toHaveLength(1);
        expect(result.newState.status).toBe("running");
      });
      it("should handle LLM response with tool calls", async () => {
        const agent = new MockAgent();
        async function* mockModelRuntime(payload) {
          yield { content: "I need to use a tool" };
          yield {
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: { name: "test_tool", arguments: "{}" }
              }
            ]
          };
        }
        agent.modelRuntime = mockModelRuntime;
        const runtime = new AgentRuntime(agent);
        const state = AgentRuntime.createInitialState({
          operationId: "test-session",
          messages: [{ role: "user", content: "Hello" }]
        });
        const result = await runtime.step(state);
        expect(result.events).toContainEqual(
          expect.objectContaining({
            type: "llm_result",
            result: expect.objectContaining({
              content: "I need to use a tool",
              tool_calls: [
                {
                  id: "call_123",
                  type: "function",
                  function: { name: "test_tool", arguments: "{}" }
                }
              ]
            })
          })
        );
      });
    });
    describe("call_tool executor", () => {
      it("should execute tool and add result to messages", async () => {
        const agent = new MockAgent();
        agent.tools = {
          calculator: vi.fn().mockResolvedValue({ result: 42 })
        };
        const runtime = new AgentRuntime(agent);
        const state = AgentRuntime.createInitialState({ operationId: "test-session" });
        const toolCall = {
          id: "call_123",
          apiName: "calculator",
          identifier: "calculator",
          arguments: '{"expression": "2+2"}',
          type: "default"
        };
        const result = await runtime.approveToolCall(state, toolCall);
        expect(agent.tools.calculator).toHaveBeenCalledWith({ expression: "2+2" });
        expect(result.events).toHaveLength(1);
        expect(result.events[0]).toMatchObject({
          type: "tool_result",
          id: "call_123",
          result: { result: 42 }
        });
        expect(result.newState.messages).toHaveLength(1);
        expect(result.newState.messages[0]).toMatchObject({
          role: "tool",
          tool_call_id: "call_123",
          content: '{"result":42}'
        });
      });
      it("should throw error for unknown tool", async () => {
        const agent = new MockAgent();
        const runtime = new AgentRuntime(agent);
        const state = AgentRuntime.createInitialState({ operationId: "test-session" });
        const toolCall = {
          id: "call_123",
          apiName: "unknown_tool",
          identifier: "unknown_tool",
          arguments: "{}",
          type: "default"
        };
        const result = await runtime.approveToolCall(state, toolCall);
        expect(result.events[0].type).toBe("error");
        expect(result.events[0].error.message).toContain(
          "Tool not found: unknown_tool"
        );
      });
    });
    describe("human interaction executors", () => {
      it("should handle human approve request", async () => {
        const agent = new MockAgent();
        agent.runner = vi.fn().mockImplementation(
          () => Promise.resolve({
            type: "request_human_approve",
            pendingToolsCalling: [
              {
                apiName: "test_tool",
                arguments: "{}",
                id: "call_123",
                identifier: "test_tool",
                type: "default"
              }
            ]
          })
        );
        const runtime = new AgentRuntime(agent);
        const state = AgentRuntime.createInitialState({ operationId: "test-session" });
        const result = await runtime.step(state);
        expect(result.events).toHaveLength(1);
        expect(result.events[0]).toMatchObject({
          type: "human_approve_required",
          operationId: "test-session"
        });
        expect(result.newState.status).toBe("waiting_for_human");
        expect(result.newState.pendingToolsCalling).toBeDefined();
      });
      it("should handle human prompt request", async () => {
        const agent = new MockAgent();
        agent.runner = vi.fn().mockImplementation(
          () => Promise.resolve({
            type: "request_human_prompt",
            prompt: "Please provide input",
            metadata: { key: "value" }
          })
        );
        const runtime = new AgentRuntime(agent);
        const state = AgentRuntime.createInitialState({ operationId: "test-session" });
        const result = await runtime.step(state);
        expect(result.events).toHaveLength(1);
        expect(result.events[0]).toMatchObject({
          type: "human_prompt_required",
          prompt: "Please provide input",
          metadata: { key: "value" },
          operationId: "test-session"
        });
        expect(result.newState.status).toBe("waiting_for_human");
        expect(result.newState.pendingHumanPrompt).toEqual({
          prompt: "Please provide input",
          metadata: { key: "value" }
        });
      });
      it("should handle human select request", async () => {
        const agent = new MockAgent();
        agent.runner = vi.fn().mockImplementation(
          () => Promise.resolve({
            type: "request_human_select",
            prompt: "Choose an option",
            options: [
              { label: "Option 1", value: "opt1" },
              { label: "Option 2", value: "opt2" }
            ],
            multi: false
          })
        );
        const runtime = new AgentRuntime(agent);
        const state = AgentRuntime.createInitialState({ operationId: "test-session" });
        const result = await runtime.step(state);
        expect(result.events).toHaveLength(1);
        expect(result.events[0]).toMatchObject({
          type: "human_select_required",
          prompt: "Choose an option",
          options: [
            { label: "Option 1", value: "opt1" },
            { label: "Option 2", value: "opt2" }
          ],
          multi: false,
          operationId: "test-session"
        });
        expect(result.newState.status).toBe("waiting_for_human");
      });
    });
    describe("finish executor", () => {
      it("should mark conversation as done", async () => {
        const agent = new MockAgent();
        agent.runner = vi.fn().mockImplementation(
          () => Promise.resolve({
            type: "finish",
            reason: "completed",
            reasonDetail: "Task completed"
          })
        );
        const runtime = new AgentRuntime(agent);
        const state = AgentRuntime.createInitialState({ operationId: "test-session" });
        const result = await runtime.step(state);
        expect(result.events).toHaveLength(1);
        expect(result.events[0]).toMatchObject({
          type: "done",
          finalState: expect.objectContaining({
            status: "done"
          }),
          reason: "completed",
          reasonDetail: "Task completed"
        });
        expect(result.newState.status).toBe("done");
      });
    });
  });
  describe("createInitialState", () => {
    it("should create initial state without message", () => {
      const state = AgentRuntime.createInitialState({ operationId: "test-session" });
      expect(state).toMatchObject({
        operationId: "test-session",
        status: "idle",
        messages: [],
        stepCount: 0,
        createdAt: expect.any(String),
        lastModified: expect.any(String)
      });
    });
    it("should create initial state with message", () => {
      const state = AgentRuntime.createInitialState({
        operationId: "test-session",
        messages: [{ role: "user", content: "Hello world" }]
      });
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]).toMatchObject({
        role: "user",
        content: "Hello world"
      });
      expect(state.stepCount).toBe(0);
    });
    it("should create initial state with custom stepCount", () => {
      const state = AgentRuntime.createInitialState({
        operationId: "test-session",
        stepCount: 5
      });
      expect(state.stepCount).toBe(5);
    });
    it("should create initial state with maxSteps limit", () => {
      const state = AgentRuntime.createInitialState({
        operationId: "test-session",
        maxSteps: 10
      });
      expect(state.maxSteps).toBe(10);
      expect(state.stepCount).toBe(0);
    });
  });
  describe("Step Count Tracking", () => {
    it("should increment stepCount on each step execution", async () => {
      const agent = new MockAgent();
      const runtime = new AgentRuntime(agent);
      let state = AgentRuntime.createInitialState({ operationId: "test-session" });
      expect(state.stepCount).toBe(0);
      const result1 = await runtime.step(state, createTestContext("user_input"));
      expect(result1.newState.stepCount).toBe(1);
      const result2 = await runtime.step(result1.newState, createTestContext("user_input"));
      expect(result2.newState.stepCount).toBe(2);
    });
    it("should respect maxSteps limit", async () => {
      const agent = new MockAgent();
      agent.modelRuntime = async function* () {
        yield { content: "test response" };
      };
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({
        operationId: "test-session",
        maxSteps: 3
        // 允许 3 步
      });
      const result1 = await runtime.step(state, createTestContext("user_input"));
      expect(result1.newState.stepCount).toBe(1);
      expect(result1.newState.status).not.toBe("error");
      const result2 = await runtime.step(result1.newState, createTestContext("user_input"));
      expect(result2.newState.stepCount).toBe(2);
      expect(result2.newState.status).not.toBe("error");
      const result3 = await runtime.step(result2.newState, createTestContext("user_input"));
      expect(result3.newState.stepCount).toBe(3);
      expect(result3.newState.status).not.toBe("error");
      const result4 = await runtime.step(result3.newState, createTestContext("user_input"));
      expect(result4.newState.stepCount).toBe(4);
      expect(result4.newState.status).toBe("done");
      expect(result4.events[0]).toMatchObject({
        type: "done",
        finalState: expect.objectContaining({
          status: "done"
        }),
        reason: "max_steps_exceeded",
        reasonDetail: "Maximum steps exceeded: 3"
      });
    });
    it("should include stepCount in session context", async () => {
      const agent = new MockAgent();
      const runnerSpy = vi.spyOn(agent, "runner");
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({
        operationId: "test-session",
        stepCount: 5,
        // Start with step 5
        messages: [{ role: "user", content: "test" }]
      });
      await runtime.step(state);
      expect(runnerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({
            stepCount: 6
            // Should be incremented
          })
        }),
        expect.any(Object)
      );
    });
  });
  describe("Interruption Handling", () => {
    it("should interrupt execution with reason and metadata", () => {
      const agent = new MockAgent();
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({
        operationId: "test-session",
        stepCount: 3
      });
      const result = runtime.interrupt(state, "User requested stop", true, {
        userAction: "stop_button"
      });
      expect(result.newState.status).toBe("interrupted");
      expect(result.newState.interruption).toMatchObject({
        reason: "User requested stop",
        canResume: true,
        interruptedAt: expect.any(String)
      });
      expect(result.events[0]).toMatchObject({
        type: "interrupted",
        reason: "User requested stop",
        canResume: true,
        metadata: { userAction: "stop_button" },
        interruptedAt: expect.any(String)
      });
    });
    it("should resume from interrupted state", async () => {
      const agent = new MockAgent();
      agent.modelRuntime = async function* () {
        yield { content: "resumed response" };
      };
      const runtime = new AgentRuntime(agent);
      let state = AgentRuntime.createInitialState({ operationId: "test-session" });
      const interruptResult = runtime.interrupt(state, "Test interruption");
      const resumeResult = await runtime.resume(interruptResult.newState, "Test resume");
      expect(resumeResult.newState.status).toBe("running");
      expect(resumeResult.newState.interruption).toBeUndefined();
      expect(resumeResult.events[0]).toMatchObject({
        type: "resumed",
        reason: "Test resume",
        resumedFromStep: 0,
        resumedAt: expect.any(String)
      });
    });
    it("should not allow resume if canResume is false", async () => {
      const agent = new MockAgent();
      const runtime = new AgentRuntime(agent);
      let state = AgentRuntime.createInitialState({ operationId: "test-session" });
      const interruptResult = runtime.interrupt(state, "Fatal error", false);
      await expect(runtime.resume(interruptResult.newState)).rejects.toThrow(
        "Cannot resume: interruption is not resumable"
      );
    });
    it("should not allow resume from non-interrupted state", async () => {
      const agent = new MockAgent();
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({ operationId: "test-session" });
      await expect(runtime.resume(state)).rejects.toThrow(
        "Cannot resume: state is not interrupted"
      );
    });
    it("should resume with specific context", async () => {
      const agent = new MockAgent();
      agent.modelRuntime = async function* () {
        yield { content: "context-specific response" };
      };
      const runtime = new AgentRuntime(agent);
      let state = AgentRuntime.createInitialState({
        operationId: "test-session",
        messages: [{ role: "user", content: "Hello" }]
      });
      const interruptResult = runtime.interrupt(state, "Test interruption");
      const resumeContext = {
        phase: "user_input",
        payload: { message: { role: "user", content: "Hello" } },
        session: {
          // Note: AgentRuntimeContext.session uses sessionId for backward compatibility
          sessionId: "test-session",
          messageCount: 1,
          status: "interrupted",
          stepCount: 0
        }
      };
      const resumeResult = await runtime.resume(
        interruptResult.newState,
        "Resume with context",
        resumeContext
      );
      expect(resumeResult.events.length).toBeGreaterThanOrEqual(2);
      expect(resumeResult.events[0].type).toBe("resumed");
      expect(resumeResult.newState.status).toBe("running");
      expect(resumeResult.events.map((e) => e.type)).toContain("llm_start");
      expect(resumeResult.events.map((e) => e.type)).toContain("llm_result");
    });
  });
  describe("Usage and Cost Tracking", () => {
    it("should initialize with zero usage and cost", () => {
      const state = AgentRuntime.createInitialState({ operationId: "test-session" });
      expect(state.usage).toMatchObject({
        llm: {
          tokens: { input: 0, output: 0, total: 0 },
          apiCalls: 0,
          processingTimeMs: 0
        },
        tools: {
          totalCalls: 0,
          byTool: [],
          totalTimeMs: 0
        },
        humanInteraction: {
          approvalRequests: 0,
          promptRequests: 0,
          selectRequests: 0,
          totalWaitingTimeMs: 0
        }
      });
      expect(state.cost).toMatchObject({
        llm: {
          byModel: [],
          total: 0,
          currency: "USD"
        },
        tools: {
          byTool: [],
          total: 0,
          currency: "USD"
        },
        total: 0,
        currency: "USD",
        calculatedAt: expect.any(String)
      });
    });
    it("should track usage and cost through agent methods", async () => {
      class CostTrackingAgent {
        tools = {
          test_tool: async () => ({ result: "success" })
        };
        async runner(context, state2) {
          switch (context.phase) {
            case "user_input":
              return { type: "call_llm", payload: { messages: state2.messages } };
            default:
              return {
                type: "finish",
                reason: "completed",
                reasonDetail: "Done"
              };
          }
        }
        calculateUsage(operationType, operationResult, previousUsage) {
          const newUsage = structuredClone(previousUsage);
          if (operationType === "llm") {
            newUsage.llm.tokens.input += 100;
            newUsage.llm.tokens.output += 50;
            newUsage.llm.tokens.total += 150;
            newUsage.llm.apiCalls += 1;
            newUsage.llm.processingTimeMs += 1e3;
          }
          return newUsage;
        }
        calculateCost(context) {
          const newCost = structuredClone(context.previousCost || context.usage);
          const tokenCost = context.usage.llm.tokens.total / 1e3 * 0.01;
          newCost.llm.total = tokenCost;
          newCost.total = tokenCost;
          newCost.calculatedAt = (/* @__PURE__ */ new Date()).toISOString();
          return newCost;
        }
        modelRuntime = async function* () {
          yield { content: "test response" };
        };
      }
      const agent = new CostTrackingAgent();
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({
        operationId: "test-session",
        messages: [{ role: "user", content: "Hello" }]
      });
      const result = await runtime.step(state, createTestContext("user_input"));
      expect(result.newState.usage.llm.tokens.total).toBe(150);
      expect(result.newState.usage.llm.apiCalls).toBe(1);
      expect(result.newState.cost.total).toBe(15e-4);
    });
    it("should respect cost limits with stop action", async () => {
      class CostTrackingAgent {
        async runner(context, state2) {
          return { type: "call_llm", payload: { messages: state2.messages } };
        }
        calculateUsage(operationType, operationResult, previousUsage) {
          const newUsage = structuredClone(previousUsage);
          newUsage.llm.tokens.total += 1e3;
          return newUsage;
        }
        calculateCost(context) {
          const newCost = structuredClone(context.previousCost || {});
          newCost.total = 10;
          newCost.currency = "USD";
          newCost.calculatedAt = (/* @__PURE__ */ new Date()).toISOString();
          return newCost;
        }
        modelRuntime = async function* () {
          yield { content: "test response" };
        };
      }
      const agent = new CostTrackingAgent();
      const runtime = new AgentRuntime(agent);
      const costLimit = {
        maxTotalCost: 5,
        currency: "USD",
        onExceeded: "stop"
      };
      const state = AgentRuntime.createInitialState({
        operationId: "test-session",
        messages: [{ role: "user", content: "Hello" }],
        costLimit
      });
      const result = await runtime.step(state, createTestContext("user_input"));
      expect(result.newState.status).toBe("done");
      expect(result.events[0]).toMatchObject({
        type: "done",
        reason: "cost_limit_exceeded",
        reasonDetail: expect.stringContaining("Cost limit exceeded")
      });
    });
    it("should handle cost limit with interrupt action", async () => {
      class CostTrackingAgent {
        async runner(context, state2) {
          return { type: "call_llm", payload: { messages: state2.messages } };
        }
        calculateCost(context) {
          return {
            llm: { byModel: [], total: 15, currency: "USD" },
            tools: { byTool: [], total: 0, currency: "USD" },
            total: 15,
            currency: "USD",
            calculatedAt: (/* @__PURE__ */ new Date()).toISOString()
          };
        }
        modelRuntime = async function* () {
          yield { content: "test response" };
        };
      }
      const agent = new CostTrackingAgent();
      const runtime = new AgentRuntime(agent);
      const costLimit = {
        maxTotalCost: 10,
        currency: "USD",
        onExceeded: "interrupt"
      };
      const state = AgentRuntime.createInitialState({
        operationId: "test-session",
        messages: [{ role: "user", content: "Hello" }],
        costLimit
      });
      const result = await runtime.step(state, createTestContext("user_input"));
      expect(result.newState.status).toBe("interrupted");
      expect(result.events[0]).toMatchObject({
        type: "interrupted",
        reason: expect.stringContaining("Cost limit exceeded"),
        metadata: expect.objectContaining({
          costExceeded: true
        })
      });
    });
  });
  describe("Integration Tests", () => {
    it("should complete a full conversation flow", async () => {
      const agent = new MockAgent();
      agent.tools = {
        get_weather: vi.fn().mockResolvedValue({
          temperature: 25,
          condition: "sunny"
        })
      };
      agent.runner = vi.fn().mockImplementation((context, state2) => {
        switch (context.phase) {
          case "user_input":
            return Promise.resolve({ type: "call_llm", payload: { messages: state2.messages } });
          case "llm_result":
            const llmPayload = context.payload;
            if (llmPayload.hasToolCalls) {
              const pendingToolsCalling = llmPayload.result.tool_calls.map((tc) => ({
                apiName: tc.function.name,
                arguments: tc.function.arguments,
                id: tc.id,
                identifier: tc.function.name,
                type: "default"
              }));
              return Promise.resolve({
                pendingToolsCalling,
                type: "request_human_approve"
              });
            }
            return Promise.resolve({ type: "finish", reason: "completed", reasonDetail: "Done" });
          case "human_approved_tool":
            const approvedPayload = context.payload;
            return Promise.resolve({
              payload: {
                parentMessageId: "user-msg-id",
                toolCalling: approvedPayload.approvedToolCall
              },
              type: "call_tool"
            });
          case "tool_result":
            return Promise.resolve({ type: "call_llm", payload: { messages: state2.messages } });
          default:
            return Promise.resolve({ type: "finish", reason: "completed", reasonDetail: "Done" });
        }
      });
      async function* mockModelRuntime(payload) {
        const messages = payload.messages;
        const lastMessage = messages[messages.length - 1];
        if (lastMessage.role === "user") {
          yield { content: "I'll check the weather for you." };
          yield {
            tool_calls: [
              {
                id: "call_weather",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city": "Beijing"}'
                }
              }
            ]
          };
        } else if (lastMessage.role === "tool") {
          yield { content: "The weather in Beijing is 25\xB0C and sunny." };
        }
      }
      agent.modelRuntime = mockModelRuntime;
      const runtime = new AgentRuntime(agent);
      let state = AgentRuntime.createInitialState({
        operationId: "test-session",
        messages: [{ role: "user", content: "What's the weather in Beijing?" }]
      });
      let result = await runtime.step(state);
      expect(result.newState.status).toBe("running");
      expect(result.newState.messages).toHaveLength(1);
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: "llm_result",
          result: expect.objectContaining({
            tool_calls: expect.arrayContaining([
              expect.objectContaining({
                id: "call_weather",
                type: "function"
              })
            ])
          })
        })
      );
      result = await runtime.step(result.newState, result.nextContext);
      expect(result.newState.status).toBe("waiting_for_human");
      expect(result.newState.pendingToolsCalling).toHaveLength(1);
      const pendingToolCall = result.newState.pendingToolsCalling[0];
      const toolCall = {
        apiName: pendingToolCall.apiName,
        arguments: pendingToolCall.arguments,
        id: pendingToolCall.id,
        identifier: pendingToolCall.identifier,
        type: "default"
      };
      result = await runtime.approveToolCall(result.newState, toolCall);
      expect(agent.tools.get_weather).toHaveBeenCalledWith({ city: "Beijing" });
      expect(result.newState.messages).toHaveLength(2);
      result = await runtime.step(result.newState, result.nextContext);
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: "llm_result",
          result: expect.objectContaining({
            content: expect.stringContaining("25\xB0C and sunny")
          })
        })
      );
    });
  });
  describe("Batch Tool Execution", () => {
    it("should execute multiple tools concurrently with call_tools_batch instruction", async () => {
      class BatchToolAgent {
        tools = {
          tool_a: vi.fn().mockResolvedValue({ result: "result_a" }),
          tool_b: vi.fn().mockResolvedValue({ result: "result_b" }),
          tool_c: vi.fn().mockResolvedValue({ result: "result_c" })
        };
        async runner(context, _state) {
          if (context.phase === "user_input") {
            return {
              payload: [
                {
                  id: "call_a",
                  type: "function",
                  function: { name: "tool_a", arguments: "{}" }
                },
                {
                  id: "call_b",
                  type: "function",
                  function: { name: "tool_b", arguments: "{}" }
                },
                {
                  id: "call_c",
                  type: "function",
                  function: { name: "tool_c", arguments: "{}" }
                }
              ],
              type: "call_tools_batch"
            };
          }
          return { type: "finish", reason: "completed" };
        }
      }
      const agent = new BatchToolAgent();
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({
        operationId: "batch-test",
        messages: [{ role: "user", content: "Execute tools" }]
      });
      const result = await runtime.step(state);
      expect(agent.tools.tool_a).toHaveBeenCalled();
      expect(agent.tools.tool_b).toHaveBeenCalled();
      expect(agent.tools.tool_c).toHaveBeenCalled();
      expect(result.events.filter((e) => e.type === "tool_result")).toHaveLength(3);
      const toolMessages = result.newState.messages.filter((m) => m.role === "tool");
      expect(toolMessages).toHaveLength(3);
      expect(result.nextContext?.phase).toBe("tools_batch_result");
      expect(result.nextContext?.payload).toHaveProperty("toolCount", 3);
    });
    it("should support agent returning instruction array", async () => {
      class ArrayReturnAgent {
        tools = {
          tool_1: vi.fn().mockResolvedValue({ result: "tool_1_result" }),
          tool_2: vi.fn().mockResolvedValue({ result: "tool_2_result" })
        };
        async runner(context, _state) {
          if (context.phase === "user_input") {
            return [
              {
                payload: {
                  parentMessageId: "user-msg-id",
                  toolCalling: {
                    id: "call_1",
                    type: "default",
                    apiName: "tool_1",
                    identifier: "tool_1",
                    arguments: "{}"
                  }
                },
                type: "call_tool"
              },
              {
                payload: {
                  parentMessageId: "user-msg-id",
                  toolCalling: {
                    id: "call_2",
                    type: "default",
                    apiName: "tool_2",
                    identifier: "tool_2",
                    arguments: "{}"
                  }
                },
                type: "call_tool"
              }
            ];
          }
          return { type: "finish", reason: "completed" };
        }
      }
      const agent = new ArrayReturnAgent();
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({
        operationId: "array-test",
        messages: [{ role: "user", content: "Execute tools" }]
      });
      const result = await runtime.step(state);
      expect(agent.tools.tool_1).toHaveBeenCalled();
      expect(agent.tools.tool_2).toHaveBeenCalled();
      expect(result.events.filter((e) => e.type === "tool_result")).toHaveLength(2);
      const toolMessages = result.newState.messages.filter((m) => m.role === "tool");
      expect(toolMessages).toHaveLength(2);
    });
    it("should stop execution when encountering blocking status", async () => {
      class BlockingAgent {
        tools = {
          safe_tool: vi.fn().mockResolvedValue({ result: "safe_result" })
        };
        async runner(context, _state) {
          if (context.phase === "user_input") {
            return [
              {
                payload: {
                  parentMessageId: "user-msg-id",
                  toolCalling: {
                    id: "call_safe",
                    type: "default",
                    apiName: "safe_tool",
                    identifier: "safe_tool",
                    arguments: "{}"
                  }
                },
                type: "call_tool"
              },
              {
                pendingToolsCalling: [
                  {
                    apiName: "danger_tool",
                    arguments: "{}",
                    id: "call_danger",
                    identifier: "danger_tool",
                    type: "default"
                  }
                ],
                type: "request_human_approve"
              }
            ];
          }
          return { type: "finish", reason: "completed" };
        }
      }
      const agent = new BlockingAgent();
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({
        operationId: "blocking-test",
        messages: [{ role: "user", content: "Execute" }]
      });
      const result = await runtime.step(state);
      expect(agent.tools.safe_tool).toHaveBeenCalled();
      expect(result.newState.status).toBe("waiting_for_human");
      expect(result.newState.pendingToolsCalling).toHaveLength(1);
      expect(result.newState.pendingToolsCalling[0].apiName).toBe("danger_tool");
      expect(result.events).toContainEqual(expect.objectContaining({ type: "tool_result" }));
      expect(result.events).toContainEqual(
        expect.objectContaining({ type: "human_approve_required" })
      );
    });
    it("should merge tool results correctly", async () => {
      class UsageTrackingAgent {
        tools = {
          expensive_tool: vi.fn().mockResolvedValue({ cost: 10 }),
          cheap_tool: vi.fn().mockResolvedValue({ cost: 1 })
        };
        calculateUsage(operationType, operationResult, previousUsage) {
          if (operationType === "tool") {
            return {
              ...previousUsage,
              tools: {
                ...previousUsage.tools,
                totalCalls: previousUsage.tools.totalCalls + 1,
                totalTimeMs: previousUsage.tools.totalTimeMs + 100
              }
            };
          }
          return previousUsage;
        }
        async runner(context, _state) {
          if (context.phase === "user_input") {
            return {
              payload: {
                parentMessageId: "user-msg-id",
                toolsCalling: [
                  {
                    id: "call_expensive",
                    type: "default",
                    apiName: "expensive_tool",
                    identifier: "expensive_tool",
                    arguments: "{}"
                  },
                  {
                    id: "call_cheap",
                    type: "default",
                    apiName: "cheap_tool",
                    identifier: "cheap_tool",
                    arguments: "{}"
                  }
                ]
              },
              type: "call_tools_batch"
            };
          }
          return { type: "finish", reason: "completed" };
        }
      }
      const agent = new UsageTrackingAgent();
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({
        operationId: "merge-test",
        messages: [{ role: "user", content: "Execute" }]
      });
      const result = await runtime.step(state);
      expect(agent.tools.expensive_tool).toHaveBeenCalled();
      expect(agent.tools.cheap_tool).toHaveBeenCalled();
      expect(result.newState.usage.tools.totalCalls).toBe(2);
    });
  });
  describe("Multi-Round Batch Tool Execution (upstream issue 1657)", () => {
    it("should not duplicate tool messages across multiple batch executions", async () => {
      const executionLog = [];
      class MultiRoundBatchAgent {
        roundCount = 0;
        tools = {
          search_tool: vi.fn().mockImplementation(async (args) => {
            executionLog.push(`search_tool(${args.query})`);
            return { result: `search result for ${args.query}` };
          }),
          crawl_tool: vi.fn().mockImplementation(async (args) => {
            executionLog.push(`crawl_tool(${args.url})`);
            return { content: `content from ${args.url}` };
          })
        };
        async runner(context, state2) {
          executionLog.push(`runner(${context.phase})`);
          switch (context.phase) {
            case "user_input":
              return { type: "call_llm", payload: { messages: state2.messages } };
            case "llm_result": {
              const llmPayload = context.payload;
              if (llmPayload.hasToolCalls) {
                this.roundCount++;
                const toolsCalling = llmPayload.result.tool_calls.map((tc) => ({
                  id: tc.id,
                  type: "default",
                  apiName: tc.function.name,
                  identifier: tc.function.name,
                  arguments: tc.function.arguments
                }));
                return {
                  type: "call_tools_batch",
                  payload: {
                    parentMessageId: "assistant-msg",
                    toolsCalling
                  }
                };
              }
              return { type: "finish", reason: "completed" };
            }
            case "tools_batch_result":
              return { type: "call_llm", payload: { messages: state2.messages } };
            default:
              return { type: "finish", reason: "completed" };
          }
        }
        // Mock LLM that returns tool calls for first 2 rounds, then finishes
        modelRuntime = async function* (payload) {
          const toolMessages2 = payload.messages.filter((m) => m.role === "tool");
          executionLog.push(`modelRuntime(tool_messages=${toolMessages2.length})`);
          if (this.roundCount < 2) {
            yield { content: `Round ${this.roundCount + 1}: I will use tools.` };
            yield {
              tool_calls: [
                {
                  id: `call_search_${this.roundCount + 1}`,
                  type: "function",
                  function: {
                    name: "search_tool",
                    arguments: JSON.stringify({ query: `query_${this.roundCount + 1}` })
                  }
                },
                {
                  id: `call_crawl_${this.roundCount + 1}`,
                  type: "function",
                  function: {
                    name: "crawl_tool",
                    arguments: JSON.stringify({ url: `url_${this.roundCount + 1}` })
                  }
                }
              ]
            };
          } else {
            yield { content: "All done!" };
          }
        }.bind(this);
      }
      const agent = new MultiRoundBatchAgent();
      const runtime = new AgentRuntime(agent);
      let state = AgentRuntime.createInitialState({
        operationId: "multi-round-test",
        messages: [{ role: "user", content: "Please search and crawl some pages" }]
      });
      let result = await runtime.step(state);
      expect(result.newState.status).toBe("running");
      result = await runtime.step(result.newState, result.nextContext);
      expect(result.events.filter((e) => e.type === "tool_result")).toHaveLength(2);
      let toolMessages = result.newState.messages.filter((m) => m.role === "tool");
      expect(toolMessages).toHaveLength(2);
      expect(toolMessages.map((m) => m.tool_call_id).sort()).toEqual([
        "call_crawl_1",
        "call_search_1"
      ]);
      result = await runtime.step(result.newState, result.nextContext);
      result = await runtime.step(result.newState, result.nextContext);
      expect(result.events.filter((e) => e.type === "tool_result")).toHaveLength(2);
      toolMessages = result.newState.messages.filter((m) => m.role === "tool");
      expect(toolMessages).toHaveLength(4);
      const toolCallIds = toolMessages.map((m) => m.tool_call_id);
      const uniqueToolCallIds = [...new Set(toolCallIds)];
      expect(toolCallIds).toHaveLength(uniqueToolCallIds.length);
      expect(toolCallIds.sort()).toEqual([
        "call_crawl_1",
        "call_crawl_2",
        "call_search_1",
        "call_search_2"
      ]);
      result = await runtime.step(result.newState, result.nextContext);
      result = await runtime.step(result.newState, result.nextContext);
      expect(result.newState.status).toBe("done");
      toolMessages = result.newState.messages.filter((m) => m.role === "tool");
      expect(toolMessages).toHaveLength(4);
    });
    it("should handle mixed scenarios: existing tool messages + new batch execution", async () => {
      class TwoBatchAgent {
        batchCount = 0;
        tools = {
          tool_a: vi.fn().mockResolvedValue({ result: "a" }),
          tool_b: vi.fn().mockResolvedValue({ result: "b" })
        };
        async runner(context, _state) {
          if (context.phase === "user_input" || context.phase === "tools_batch_result") {
            this.batchCount++;
            if (this.batchCount === 1) {
              return {
                type: "call_tools_batch",
                payload: {
                  parentMessageId: "msg",
                  toolsCalling: [
                    {
                      id: "batch1_call_a",
                      type: "default",
                      apiName: "tool_a",
                      identifier: "tool_a",
                      arguments: "{}"
                    }
                  ]
                }
              };
            } else if (this.batchCount === 2) {
              return {
                type: "call_tools_batch",
                payload: {
                  parentMessageId: "msg",
                  toolsCalling: [
                    {
                      id: "batch2_call_a",
                      type: "default",
                      apiName: "tool_a",
                      identifier: "tool_a",
                      arguments: "{}"
                    },
                    {
                      id: "batch2_call_b",
                      type: "default",
                      apiName: "tool_b",
                      identifier: "tool_b",
                      arguments: "{}"
                    }
                  ]
                }
              };
            }
          }
          return { type: "finish", reason: "completed" };
        }
      }
      const agent = new TwoBatchAgent();
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({
        operationId: "two-batch-test",
        messages: [{ role: "user", content: "test" }]
      });
      let result = await runtime.step(state);
      let toolMessages = result.newState.messages.filter((m) => m.role === "tool");
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0].tool_call_id).toBe("batch1_call_a");
      result = await runtime.step(result.newState, result.nextContext);
      toolMessages = result.newState.messages.filter((m) => m.role === "tool");
      expect(toolMessages).toHaveLength(3);
      const toolCallIds = toolMessages.map((m) => m.tool_call_id);
      expect(new Set(toolCallIds).size).toBe(3);
      expect(toolCallIds.sort()).toEqual(["batch1_call_a", "batch2_call_a", "batch2_call_b"]);
    });
  });
  describe("StepContext Passing", () => {
    it("should pass stepContext to agent runner", async () => {
      const agent = new MockAgent();
      const runnerSpy = vi.spyOn(agent, "runner");
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({
        operationId: "test-session",
        messages: [{ role: "user", content: "Hello" }]
      });
      const stepContext = {
        todos: {
          items: [
            { text: "Buy milk", status: "todo" },
            { text: "Call mom", status: "completed" }
          ],
          updatedAt: "2024-06-01T00:00:00.000Z"
        }
      };
      const context = {
        phase: "user_input",
        payload: { message: { role: "user", content: "Hello" } },
        session: {
          sessionId: "test-session",
          messageCount: 1,
          status: "idle",
          stepCount: 0
        },
        stepContext
      };
      await runtime.step(state, context);
      expect(runnerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          stepContext: expect.objectContaining({
            todos: expect.objectContaining({
              items: expect.arrayContaining([
                expect.objectContaining({ text: "Buy milk", status: "todo" })
              ])
            })
          })
        }),
        expect.any(Object)
      );
    });
    it("should pass stepContext to custom executors", async () => {
      const customExecutor = vi.fn().mockResolvedValue({
        events: [{ type: "done", finalState: {}, reason: "completed" }],
        newState: { status: "done" }
      });
      const agent = new MockAgent();
      agent.runner = vi.fn().mockResolvedValue({
        type: "finish",
        reason: "completed"
      });
      const config = {
        executors: {
          finish: customExecutor
        }
      };
      const runtime = new AgentRuntime(agent, config);
      const state = AgentRuntime.createInitialState({ operationId: "test-session" });
      const stepContext = {
        todos: {
          items: [{ text: "Task 1", status: "todo" }],
          updatedAt: "2024-06-01T00:00:00.000Z"
        }
      };
      const context = {
        phase: "init",
        session: {
          sessionId: "test-session",
          messageCount: 0,
          status: "idle",
          stepCount: 0
        },
        stepContext
      };
      await runtime.step(state, context);
      expect(customExecutor).toHaveBeenCalledWith(
        expect.any(Object),
        // instruction
        expect.any(Object),
        // state
        expect.objectContaining({
          stepContext: expect.objectContaining({
            todos: expect.objectContaining({
              items: expect.arrayContaining([expect.objectContaining({ text: "Task 1" })])
            })
          })
        })
      );
    });
    it("should pass stepContext to batch tool execution", async () => {
      const toolASpy = vi.fn().mockResolvedValue({ result: "a" });
      const toolBSpy = vi.fn().mockResolvedValue({ result: "b" });
      class BatchToolAgent {
        tools = {
          tool_a: toolASpy,
          tool_b: toolBSpy
        };
        async runner(context2, _state) {
          if (context2.phase === "user_input") {
            return {
              type: "call_tools_batch",
              payload: {
                parentMessageId: "msg",
                toolsCalling: [
                  {
                    id: "call_a",
                    type: "default",
                    apiName: "tool_a",
                    identifier: "tool_a",
                    arguments: "{}"
                  },
                  {
                    id: "call_b",
                    type: "default",
                    apiName: "tool_b",
                    identifier: "tool_b",
                    arguments: "{}"
                  }
                ]
              }
            };
          }
          return { type: "finish", reason: "completed" };
        }
      }
      const agent = new BatchToolAgent();
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({
        operationId: "batch-test",
        messages: [{ role: "user", content: "Execute tools" }]
      });
      const stepContext = {
        todos: {
          items: [{ text: "Batch task", status: "todo" }],
          updatedAt: "2024-06-01T00:00:00.000Z"
        }
      };
      const context = {
        phase: "user_input",
        payload: { message: { role: "user", content: "Execute tools" } },
        session: {
          sessionId: "batch-test",
          messageCount: 1,
          status: "idle",
          stepCount: 0
        },
        stepContext
      };
      const result = await runtime.step(state, context);
      expect(toolASpy).toHaveBeenCalled();
      expect(toolBSpy).toHaveBeenCalled();
      expect(result.nextContext?.phase).toBe("tools_batch_result");
    });
    it("should handle undefined stepContext gracefully", async () => {
      const agent = new MockAgent();
      agent.runner = vi.fn().mockResolvedValue({
        type: "finish",
        reason: "completed"
      });
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({ operationId: "test-session" });
      const context = {
        phase: "init",
        session: {
          sessionId: "test-session",
          messageCount: 0,
          status: "idle",
          stepCount: 0
        }
        // No stepContext
      };
      const result = await runtime.step(state, context);
      expect(result.newState.status).toBe("done");
      expect(result.events[0].type).toBe("done");
    });
  });
  describe("Edge Cases and Error Handling", () => {
    it("should handle unknown instruction type", async () => {
      const agent = new MockAgent();
      agent.runner = vi.fn().mockResolvedValue({ type: "unknown_instruction_type" });
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({ operationId: "test-session" });
      const result = await runtime.step(state);
      expect(result.events[0].type).toBe("error");
      expect(result.events[0].error.message).toContain(
        "No executor found for instruction type"
      );
    });
    it("should handle LLM errors", async () => {
      const agent = new MockAgent();
      agent.modelRuntime = async function* () {
        throw new Error("LLM API error");
      };
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({
        messages: [{ role: "user", content: "test" }],
        operationId: "test-session"
      });
      const result = await runtime.step(state);
      expect(result.events[0].type).toBe("error");
      expect(result.events[0].error.message).toBe("LLM API error");
    });
    it("should handle cost limit with warn action", async () => {
      class WarnCostAgent {
        async runner(context, state2) {
          return { type: "call_llm", payload: { messages: state2.messages } };
        }
        calculateCost(context) {
          return {
            calculatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            currency: "USD",
            llm: { byModel: [], currency: "USD", total: 15 },
            tools: { byTool: [], currency: "USD", total: 0 },
            total: 15
          };
        }
        modelRuntime = async function* () {
          yield { content: "test" };
        };
      }
      const agent = new WarnCostAgent();
      const runtime = new AgentRuntime(agent);
      const costLimit = {
        currency: "USD",
        maxTotalCost: 10,
        onExceeded: "warn"
      };
      const state = AgentRuntime.createInitialState({
        costLimit,
        messages: [{ role: "user", content: "test" }],
        operationId: "test-session"
      });
      const result = await runtime.step(state);
      expect(result.events[0]).toMatchObject({
        type: "error"
      });
      expect(result.events[0].error.message).toContain(
        "Warning: Cost limit exceeded"
      );
      expect(result.newState.status).toBe("running");
    });
    it("should track tool cost limits", async () => {
      class ToolCostAgent {
        tools = {
          expensive_tool: vi.fn().mockResolvedValue({ result: "done" })
        };
        async runner(context, state2) {
          if (context.phase === "user_input") {
            return {
              payload: {
                parentMessageId: "user-msg-id",
                toolCalling: {
                  apiName: "expensive_tool",
                  arguments: "{}",
                  id: "call_1",
                  identifier: "expensive_tool",
                  type: "default"
                }
              },
              type: "call_tool"
            };
          }
          return { reason: "completed", type: "finish" };
        }
        calculateCost(context) {
          return {
            calculatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            currency: "USD",
            llm: { byModel: [], currency: "USD", total: 0 },
            tools: { byTool: [], currency: "USD", total: 20 },
            total: 20
          };
        }
      }
      const agent = new ToolCostAgent();
      const runtime = new AgentRuntime(agent);
      const costLimit = {
        currency: "USD",
        maxTotalCost: 10,
        onExceeded: "stop"
      };
      const state = AgentRuntime.createInitialState({
        costLimit,
        messages: [{ role: "user", content: "test" }],
        operationId: "test-session"
      });
      const result = await runtime.step(state);
      expect(result.newState.status).toBe("done");
      expect(result.events[0]).toMatchObject({
        reason: "cost_limit_exceeded",
        type: "done"
      });
    });
    it("should merge cost statistics in batch tool execution", async () => {
      class BatchCostAgent {
        tools = {
          tool_1: vi.fn().mockResolvedValue({ result: "result_1" }),
          tool_2: vi.fn().mockResolvedValue({ result: "result_2" })
        };
        calculateCost(context) {
          const baseCost = context.previousCost || {
            calculatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            currency: "USD",
            llm: { byModel: [], currency: "USD", total: 0 },
            tools: { byTool: [], currency: "USD", total: 0 },
            total: 0
          };
          return {
            ...baseCost,
            calculatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            tools: {
              byTool: [],
              currency: "USD",
              total: baseCost.tools.total + 5
            },
            total: baseCost.total + 5
          };
        }
        async runner(context, _state) {
          if (context.phase === "user_input") {
            return {
              payload: {
                parentMessageId: "user-msg-id",
                toolsCalling: [
                  {
                    apiName: "tool_1",
                    arguments: "{}",
                    id: "call_1",
                    identifier: "tool_1",
                    type: "default"
                  },
                  {
                    apiName: "tool_2",
                    arguments: "{}",
                    id: "call_2",
                    identifier: "tool_2",
                    type: "default"
                  }
                ]
              },
              type: "call_tools_batch"
            };
          }
          return { reason: "completed", type: "finish" };
        }
      }
      const agent = new BatchCostAgent();
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({
        messages: [{ role: "user", content: "Execute" }],
        operationId: "cost-merge-test"
      });
      const result = await runtime.step(state);
      expect(result.newState.cost.tools.total).toBeGreaterThan(0);
      expect(result.newState.cost.total).toBeGreaterThan(0);
    });
    it("should merge per-tool usage statistics in batch execution", async () => {
      class DetailedUsageAgent {
        tools = {
          analytics_tool: vi.fn().mockResolvedValue({ result: "analytics_done" }),
          logging_tool: vi.fn().mockResolvedValue({ result: "logged" })
        };
        calculateUsage(operationType, operationResult, previousUsage) {
          if (operationType === "tool") {
            const toolName = operationResult.toolCall.apiName;
            const newUsage = structuredClone(previousUsage);
            newUsage.tools.totalCalls += 1;
            newUsage.tools.totalTimeMs += 100;
            const existingTool = newUsage.tools.byTool.find((t) => t.name === toolName);
            if (existingTool) {
              existingTool.calls += 1;
              existingTool.totalTimeMs += 100;
            } else {
              newUsage.tools.byTool.push({
                calls: 1,
                errors: 0,
                name: toolName,
                totalTimeMs: 100
              });
            }
            return newUsage;
          }
          return previousUsage;
        }
        async runner(context, _state) {
          if (context.phase === "user_input") {
            return {
              payload: {
                parentMessageId: "user-msg-id",
                toolsCalling: [
                  {
                    apiName: "analytics_tool",
                    arguments: "{}",
                    id: "call_analytics",
                    identifier: "analytics_tool",
                    type: "default"
                  },
                  {
                    apiName: "logging_tool",
                    arguments: "{}",
                    id: "call_logging",
                    identifier: "logging_tool",
                    type: "default"
                  }
                ]
              },
              type: "call_tools_batch"
            };
          }
          return { reason: "completed", type: "finish" };
        }
      }
      const agent = new DetailedUsageAgent();
      const runtime = new AgentRuntime(agent);
      const state = AgentRuntime.createInitialState({
        messages: [{ role: "user", content: "Execute" }],
        operationId: "usage-merge-test"
      });
      const result = await runtime.step(state);
      expect(result.newState.usage.tools.totalCalls).toBe(2);
      const analyticsTool = result.newState.usage.tools.byTool.find(
        (t) => t.name === "analytics_tool"
      );
      const loggingTool = result.newState.usage.tools.byTool.find((t) => t.name === "logging_tool");
      expect(analyticsTool).toBeDefined();
      expect(analyticsTool.calls).toBe(1);
      expect(loggingTool).toBeDefined();
      expect(loggingTool.calls).toBe(1);
    });
  });
});
