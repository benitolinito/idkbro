import type { ApprovalDecision } from "@multicode/protocol";

/** Build an approval command that can only target the active room. */
export function hostApprovalCliArgs(
  roomSessionId: string | undefined,
  requestId: string | number,
  decision: ApprovalDecision,
): string[] {
  const session = roomSessionId?.trim();
  if (!session) throw new Error("MultiCode has not identified the active room yet; the approval was not sent");
  return ["approve", String(requestId), decision, "--session", session];
}
