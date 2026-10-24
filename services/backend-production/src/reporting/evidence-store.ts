import { constants } from "node:fs";
import { open, mkdir, lstat, unlink } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { timingSafeEqual } from "node:crypto";
const types = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
const maximum = 8_388_608;
/** Private evidence is outside the public publishing store. No symlink following. */
export class PrivateReportingEvidenceStore {
  private readonly directory: string;
  constructor(directory: string) {
    if (!isAbsolute(directory))
      throw new Error("REPORT_EVIDENCE_DIRECTORY_INVALID");
    this.directory = resolve(directory);
  }
  private async location(id: string): Promise<string> {
    if (!/^evidence-[0-9a-f]{32}$/u.test(id))
      throw new Error("REPORT_EVIDENCE_ID_INVALID");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    )
      throw new Error("REPORT_EVIDENCE_DIRECTORY_PRIVATE_REQUIRED");
    return join(this.directory, id);
  }
  async put(input: {
    id: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<void> {
    if (
      !types.has(input.mimeType) ||
      !input.bytes.length ||
      input.bytes.length > maximum
    )
      throw new Error("REPORT_EVIDENCE_INVALID");
    const location = await this.location(input.id);
    let file;
    try {
      file = await open(
        location,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new Error("REPORT_EVIDENCE_WRITE_FAILED", { cause: error });
      const existing = await this.read(input.id);
      if (
        !existing ||
        existing.mimeType !== input.mimeType ||
        existing.bytes.length !== input.bytes.length ||
        !timingSafeEqual(existing.bytes, input.bytes)
      )
        throw new Error("REPORT_EVIDENCE_CONFLICT", { cause: error });
      return;
    }
    try {
      await file.writeFile(
        Buffer.concat([Buffer.from(input.mimeType + "\n"), input.bytes]),
      );
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async read(
    id: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    const location = await this.location(id);
    let file;
    try {
      file = await open(
        location,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("REPORT_EVIDENCE_READ_FAILED", { cause: error });
    }
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > maximum + 32 ||
        (info.mode & 0o077) !== 0
      )
        throw new Error("REPORT_EVIDENCE_FILE_INVALID");
      const content = Buffer.alloc(maximum + 33);
      const result = await file.read(content, 0, content.length, 0);
      const bytes = content.subarray(0, result.bytesRead);
      const boundary = bytes.indexOf(10);
      const mimeType = bytes.subarray(0, boundary).toString("ascii");
      if (
        boundary < 1 ||
        !types.has(mimeType) ||
        bytes.length > maximum + boundary + 1
      )
        throw new Error("REPORT_EVIDENCE_FILE_INVALID");
      return { bytes: bytes.subarray(boundary + 1), mimeType };
    } finally {
      await file.close();
    }
  }
  async delete(id: string): Promise<void> {
    const location = await this.location(id);
    try {
      const info = await lstat(location);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("REPORT_EVIDENCE_FILE_INVALID");
      await unlink(location);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
