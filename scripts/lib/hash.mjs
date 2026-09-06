import { createHash } from "node:crypto";
import fs from "node:fs";

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(path, { maxBytes = Infinity } = {}) {
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(path);
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const error = new Error(`File exceeds ${maxBytes} bytes`);
        error.code = "FILE_TOO_LARGE";
        stream.destroy(error);
        return;
      }
      hash.update(chunk);
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}
