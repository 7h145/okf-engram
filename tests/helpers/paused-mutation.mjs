import fs from "node:fs/promises";
import { resolveProject } from "../../scripts/lib/project.mjs";
import { putConcept } from "../../scripts/lib/bundle.mjs";

const [root, id, draftFile, pauseAt, ifMatch = ""] = process.argv.slice(2);
const context = await resolveProject({ projectRoot: root });
const draft = await fs.readFile(draftFile, "utf8");
const pause = async () => {
  if (process.send) process.send({ paused: pauseAt });
  await new Promise(() => {});
};

await putConcept(context, id, draft, {
  ifMatch: ifMatch || undefined,
  testHooks: {
    beforeConceptWrite: pauseAt === "before" ? pause : undefined,
    afterConceptWrite: pauseAt === "after" ? pause : undefined,
  },
});
