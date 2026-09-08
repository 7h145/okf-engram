import fs from "node:fs/promises";
import { resolveProject } from "../../scripts/lib/project.mjs";
import { writeConcept } from "../../scripts/lib/bundle.mjs";

const [root, id, draftFile, pauseAt, expectedCurrentSha256 = ""] = process.argv.slice(2);
const context = await resolveProject({ projectRoot: root });
const draft = await fs.readFile(draftFile, "utf8");
const pause = async () => {
  if (process.send) process.send({ paused: pauseAt });
  await new Promise(() => {});
};

await writeConcept(context, id, draft, {
  expectedCurrentSha256: expectedCurrentSha256 || undefined,
  testHooks: {
    beforeConceptWrite: pauseAt === "before" ? pause : undefined,
    afterConceptWrite: pauseAt === "after" ? pause : undefined,
  },
});
