import { appendFileSync } from "node:fs";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const scenario = process.env.PI_COMPLETION_FIXTURE_SCENARIO;
const logFile = process.env.PI_COMPLETION_FIXTURE_LOG;
let requestCount = 0;

function message(model: Model<any>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function textResponse(model: Model<any>, text: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const output = message(model);
    stream.push({ type: "start", partial: output });
    output.content.push({ type: "text", text });
    stream.push({ type: "text_start", contentIndex: 0, partial: output });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
    output.stopReason = "stop";
    stream.push({ type: "done", reason: "stop", message: output });
    stream.end();
  });
  return stream;
}

function toolResponse(
  model: Model<any>,
  name: "subagent_done" | "subagent_wait",
  args: Record<string, string>,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const output = message(model);
    const toolCall = {
      type: "toolCall" as const,
      id: `fixture-call-${requestCount}`,
      name,
      arguments: args,
    };
    stream.push({ type: "start", partial: output });
    output.content.push(toolCall);
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
    stream.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: JSON.stringify(args),
      partial: output,
    });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
    output.stopReason = "toolUse";
    stream.push({ type: "done", reason: "toolUse", message: output });
    stream.end();
  });
  return stream;
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("completion-fixture", {
    name: "Completion protocol fixture",
    baseUrl: "http://unused.invalid",
    apiKey: "offline-fixture",
    api: "completion-fixture-api",
    models: [
      {
        id: "scripted",
        name: "Scripted completion fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10_000,
        maxTokens: 1_000,
      },
    ],
    streamSimple(model, context) {
      requestCount += 1;
      if (logFile) {
        const completionChecks = context.messages.filter((message: any) =>
          JSON.stringify(message).includes("This subagent is still open."),
        ).length;
        const forkContext = scenario === "user-fork" ? {
          tools: (context.tools ?? []).map((tool) => tool.name),
          inheritedSummary: JSON.stringify(context.messages).includes("Onboarding is complete."),
          userDrivenInstructions: context.systemPrompt?.includes("Inherited completed work is context, not a current assignment.") === true,
        } : {};
        appendFileSync(logFile, `${JSON.stringify({ request: requestCount, completionChecks, ...forkContext })}\n`);
      }

      if (scenario === "user-fork") {
        return textResponse(model, "What would you like to change or investigate?");
      }

      if (scenario === "explicit-summary") {
        return toolResponse(model, "subagent_done", { summary: "explicit runtime handoff" });
      }

      if (scenario === "reminder-completes") {
        return requestCount === 1
          ? textResponse(model, "finished without the completion marker")
          : toolResponse(model, "subagent_done", { summary: "completed after one reminder" });
      }

      if (scenario === "wait-resume") {
        return requestCount === 1
          ? toolResponse(model, "subagent_wait", { reason: "need the second RPC prompt" })
          : toolResponse(model, "subagent_done", { summary: "completed after RPC resume" });
      }

      if (scenario === "bounded-reminder") {
        if (requestCount <= 2) return textResponse(model, "same unmarked completion text");
        return toolResponse(model, "subagent_done", { summary: "fixture loop guard fired" });
      }

      throw new Error(`Unknown completion fixture scenario: ${scenario ?? "(missing)"}`);
    },
  });
}
