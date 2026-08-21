import { createHash } from "node:crypto";
import path from "node:path";

export interface WorkspaceHandoff {
  workspace: string;
  relay: string;
  name: string;
  role: "viewer" | "editor";
  mode: "host" | "join";
  roomLabel: string;
  updatedAt: number;
}

export function workspaceHandoffId(workspace: string): string {
  return createHash("sha256").update(path.resolve(workspace)).digest("hex");
}

export function workspaceHandoffSecretKey(workspace: string): string {
  return `multicode.workspace-token.${workspaceHandoffId(workspace)}`;
}
