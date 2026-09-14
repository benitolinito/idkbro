export const marketplaceExtensionUrl = "https://marketplace.visualstudio.com/items?itemName=benitolinito1.multicode-vscode";

export function inviteShareText(token: string): string {
  return [
    "Join my MultiCode session:",
    "",
    "1. Install MultiCode for VS Code:",
    marketplaceExtensionUrl,
    "",
    "2. In VS Code, run “MultiCode: Join Room”.",
    "",
    "3. Paste this complete invitation token:",
    token.trim(),
  ].join("\n");
}
