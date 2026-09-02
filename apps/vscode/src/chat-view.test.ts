import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: {
    joinPath: (_base: unknown, ...segments: string[]) => segments.join("/"),
  },
}));

import { MultiCodeChatView, type ChatActions } from "./chat-view.js";

const actions: ChatActions = {
  back: () => undefined,
  host: () => undefined,
  join: () => undefined,
  stop: () => undefined,
  submit: () => undefined,
  updateAgentSettings: () => undefined,
  updateQueuedPrompt: () => undefined,
  removeQueuedPrompt: () => undefined,
  steerQueuedPrompt: () => undefined,
  approve: () => undefined,
  answer: () => undefined,
  copyInvite: () => undefined,
  openOutput: () => undefined,
  reviewChanges: () => undefined,
  openChangedFile: () => undefined,
  openWorkspaceFile: () => undefined,
};

describe("MultiCodeChatView", () => {
  it("emits a syntactically valid webview script", () => {
    const view = new MultiCodeChatView({} as never, actions);
    const html = (view as unknown as {
      html(webview: { cspSource: string; asWebviewUri(uri: unknown): string }): string;
    }).html({
      cspSource: "vscode-webview:",
      asWebviewUri: () => "vscode-webview:/multicode-square.svg",
    });
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];

    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });
});
