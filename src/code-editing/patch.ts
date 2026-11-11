export interface TextPatch {
  expectedText: string;
  replacementText: string;
}

const MAX_PATCHES = 100;
const MAX_PATCH_TEXT = 20_000;

export function applyTextPatches(original: string, patches: TextPatch[]): string {
  if (!Array.isArray(patches) || patches.length === 0 || patches.length > MAX_PATCHES) {
    throw new Error("Provide between 1 and 100 structured text patches");
  }
  let updated = original;
  for (const [index, patch] of patches.entries()) {
    if (!patch || typeof patch.expectedText !== "string" || !patch.expectedText ||
        typeof patch.replacementText !== "string" ||
        patch.expectedText.length > MAX_PATCH_TEXT || patch.replacementText.length > MAX_PATCH_TEXT) {
      throw new Error(`Invalid structured patch ${index + 1}`);
    }
    const position = updated.indexOf(patch.expectedText);
    if (position < 0) throw new Error(`Patch ${index + 1} no longer matches the inspected file`);
    if (updated.indexOf(patch.expectedText, position + 1) >= 0) {
      throw new Error(`Patch ${index + 1} is ambiguous because its context occurs more than once`);
    }
    updated = updated.slice(0, position) + patch.replacementText +
      updated.slice(position + patch.expectedText.length);
    if (Buffer.byteLength(updated, "utf8") > 1_000_000) throw new Error("Patched content exceeds the 1 MiB file limit");
  }
  return updated;
}
