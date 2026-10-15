export const PARENT_HELP_GUIDANCE =
  "If you need the parent's decision, clarification, approval, or action, call caller_ping({message}) as your final action. " +
  "Include the blocker and specific question or requested action. This exits your session and notifies the parent, " +
  "which can resume you with guidance using subagent_resume.";

export const LOCAL_WAIT_GUIDANCE =
  "Use subagent_wait({reason}) as your final action only when waiting for an already-running nested agent " +
  "or a reply from a user you have addressed directly in this tab. Before waiting, identify what input or result will resume you. " +
  "This ends your current turn and leaves the session open. It does not notify the parent or send your reason to it. " +
  "If the parent must act first, use caller_ping({message}) instead.";

export const TASK_LIFECYCLE_GUIDANCE =
  "When finished, call subagent_done({summary}) with the full handoff as your final action. " +
  "Any preceding summary text must be commentary, not a final answer. " +
  "Do not claim completion while required work or nested agent results are outstanding. " +
  PARENT_HELP_GUIDANCE + " " + LOCAL_WAIT_GUIDANCE;

export function formatCallerPingResumeGuidance(sessionPath: string): string {
  const resumeArgs = JSON.stringify({ sessionPath, message: "<guidance for the child>" });
  return "This child exited after requesting help. Resolve the request, then use " +
    `subagent_resume(${resumeArgs}). ` +
    "A reply in the parent conversation alone does not reach the child.";
}
