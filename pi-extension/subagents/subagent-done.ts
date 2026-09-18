/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides explicit completion and wait actions plus a bounded completion reminder
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const completionMode = process.env.PI_SUBAGENT_COMPLETION_MODE === "task" ? "task" : "user";
  const taskMode = completionMode === "task";
  const autoExit = taskMode && process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  let exitRequested = false;
  let waitRequested = false;
  let completionReminderSent = false;
  let lastStopReason: string | undefined;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    if (process.env.PI_SUBAGENT_SESSION) {
      pi.appendEntry("subagent_lifecycle", { completionMode });
    }
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    completionReminderSent = false;
    recorder.input();
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", (event) => {
    recorder.beforeAgentStart();
    if (!taskMode) {
      return {
        systemPrompt: event.systemPrompt + "\n\nThis is a user-driven session, not a bounded delegated assignment. " +
          "Inherited completed work is context, not a current assignment. " +
          "If no new task is specified, ask what the user wants to work on and wait for their reply. " +
          "Normal answers and questions leave this session open. The user ends it with /quit; do not initiate a completion handoff or exit.",
      };
    }
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    waitRequested = false;
    lastStopReason = undefined;
    recorder.agentStart();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    lastStopReason = messages?.findLast((message) => message?.role === "assistant")?.stopReason;
    if (exitRequested) return;
    const shouldExit = autoExit && !waitRequested && shouldAutoExitOnAgentEnd(userTookOver, messages);

    if (shouldExit) {
      // Surface stopReason: "error" turns (auto-retry exhausted, provider
      // overload, etc.) to the parent via the .exit sidecar so the watcher
      // can report a clear failure with the underlying error message.
      // Without this the parent would only see exit code 0 and a stale
      // assistant message, mistaking the crash for a successful completion.
      const errorInfo = findLatestAssistantError(messages);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (errorInfo && sessionFile) {
        try {
          writeFileSync(
            `${sessionFile}.exit`,
            JSON.stringify({
              type: "error",
              errorMessage: errorInfo.errorMessage,
              stopReason: errorInfo.stopReason,
            }),
          );
        } catch {
          // Best effort — even without the sidecar, watcher's session-file
          // fallback can still recover the errorMessage.
        }
      }

      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  // Wait for retries and queued continuations to settle. Never turn an abort,
  // provider error, or declared wait into a completion attempt.
  pi.on("agent_settled", (_event, ctx) => {
    if (!taskMode || autoExit || exitRequested || waitRequested || completionReminderSent ||
        lastStopReason !== "stop" || ctx.hasPendingMessages()) return;
    completionReminderSent = true;
    pi.sendMessage({
      customType: "subagent_completion_check",
      content: "This subagent is still open. If the assignment is complete, call subagent_done({summary}) " +
        "with the full handoff now; do not send a final answer first. If you are intentionally waiting " +
        "for user input or nested agents, call subagent_wait({reason}) instead. Do not claim completion " +
        "while required work or child results are outstanding. This is the only reminder for this input.",
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  // User-driven sessions end through the user's /quit, not a model decision.
  if (!taskMode) return;

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      writeFileSync(`${sessionFile}.exit`, JSON.stringify(exitData));
      exitRequested = true;
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Finish the assignment and close this session. Supply the full handoff in summary; " +
      "it is returned directly to the parent. Call this as your final action, not after a final answer. " +
      "Omitting summary preserves legacy behavior: the last assistant text becomes the handoff.",
    promptSnippet: "Return the completed assignment and handoff to the parent",
    promptGuidelines: [
      "When a subagent assignment is complete, call subagent_done with the full summary as the final action. " +
      "Any preceding handoff text must be commentary, not a final answer. " +
      "Do not call subagent_done while required work or nested agent results remain outstanding.",
    ],
    parameters: Type.Object({
      summary: Type.Optional(Type.String({ minLength: 1, description: "Full handoff, including results, verification, and remaining limitations" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const summary = params.summary?.trim();
      if (params.summary !== undefined && !summary) throw new Error("summary must not be blank");
      const handoff = summary ? { summary } : {};
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (sessionFile) {
        writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done", ...handoff }));
      }
      exitRequested = true;
      recorder.subagentDone();
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: handoff,
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Subagent Wait",
    description: "Pause this run without closing the session while waiting for user input or nested agent results. " +
      "This is not completion. New input or a child result can resume the session.",
    promptSnippet: "Pause for user input or nested agents without completing the assignment",
    promptGuidelines: [
      "Use subagent_wait with a reason as the final action when intentionally waiting for user input or nested agents. " +
      "Do not call subagent_done merely to stop a turn while waiting.",
    ],
    parameters: Type.Object({ reason: Type.String({ minLength: 1, description: "What input or child result is still needed" }) }),
    async execute(_toolCallId, params) {
      const reason = params.reason.trim();
      if (!reason) throw new Error("reason must not be blank");
      waitRequested = true;
      return {
        content: [{ type: "text", text: `Session remains open: ${reason}` }],
        details: { reason },
        terminate: true,
      };
    },
  });
}
