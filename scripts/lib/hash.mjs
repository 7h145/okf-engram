import { createHash } from "node:crypto";
import fs from "node:fs";

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}
