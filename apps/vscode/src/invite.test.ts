import { describe, expect, it } from "vitest";
import { inviteShareText, marketplaceExtensionUrl } from "./invite.js";

describe("inviteShareText", () => {
  it("includes install instructions and the complete invitation token", () => {
    const token = "FXSGG-NC3GC.UDiVsUJ2RSD3AN8iAeAnIbIdLv_Z61NjLq0ST3FbVt4";
    const invitation = inviteShareText(token);

    expect(invitation).toContain(marketplaceExtensionUrl);
    expect(invitation).toContain("MultiCode: Join Room");
    expect(invitation).toContain(token);
    expect(invitation).not.toContain("FXSGG-NC3GC\n");
  });
});
