/**
 * The stored-output bound of a profile PNG (avatar or background): the
 * Backend, the relay and nginx accept at most 4 MiB. It bounds what is stored,
 * never what a reader may choose (Issue #237).
 */
export const PROFILE_PNG_MAX_BYTES = 4 * 1024 * 1024;

/** Safari adds eXIf even to an sRGB canvas. Keep only the Backend's accepted
 * chunks; their original bytes/CRCs and compressed pixels remain unchanged. */
export const normalizeAvatarPng = (bytes: Uint8Array): Uint8Array => {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length > PROFILE_PNG_MAX_BYTES ||
    !signature.every((b, i) => bytes[i] === b)
  )
    throw Error("图像导出失败，请重试");
  const chunks = [bytes.subarray(0, 8)];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8,
    ended = false;
  while (offset + 12 <= bytes.length) {
    const size = view.getUint32(offset),
      end = offset + size + 12;
    if (end > bytes.length) throw Error("图像导出失败，请重试");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (["IHDR", "IDAT", "IEND", "sRGB", "gAMA", "pHYs", "cHRM"].includes(type))
      chunks.push(bytes.subarray(offset, end));
    else if (type[0] === type[0]?.toUpperCase())
      throw Error("当前浏览器导出的图像格式不支持");
    offset = end;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended || offset !== bytes.length) throw Error("图像导出失败，请重试");
  const output = new Uint8Array(
    chunks.reduce((n, chunk) => n + chunk.length, 0),
  );
  let index = 0;
  for (const chunk of chunks) {
    output.set(chunk, index);
    index += chunk.length;
  }
  return output;
};
