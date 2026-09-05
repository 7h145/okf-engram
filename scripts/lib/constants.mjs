import fs from "node:fs";
import { fileURLToPath } from "node:url";

const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
const packageMetadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));

export const VERSION = packageMetadata.version;
export const PRODUCER = `okf-engram/${VERSION}`;
export const STATE_PARTS = [".agents", "data", "okf-engram"];
export const BUNDLE_NAME = "bundle";
export const RESERVED_BASENAMES = new Set(["index", "log"]);
export const VALID_STATUS = new Set(["draft", "stable", "deprecated"]);
export const VALID_CAPTURE = new Set(["explicit", "inferred"]);
