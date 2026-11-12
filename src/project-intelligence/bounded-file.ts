import { constants, type Stats } from "node:fs";
import { open } from "node:fs/promises";

export interface BoundedFile {
  bytes: Buffer;
  stat: Stats;
}

/** Read at most maxBytes + 1 bytes from a regular file, avoiding unbounded readFile allocations. */
export async function readBoundedRegularFile(filePath: string, maxBytes: number): Promise<BoundedFile | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("A non-negative safe file-size limit is required");
  let handle;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(filePath, constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;

    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) return null;
    return { bytes: bytes.subarray(0, offset), stat };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
