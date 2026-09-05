import lockfile from "proper-lockfile";
import { errors } from "./errors.mjs";

export async function withBundleLock(bundlePath, fn, {
  retries = 20,
  stale = 10_000,
  update = 2_500,
  retryDelay = 100,
} = {}) {
  let release;
  try {
    release = await lockfile.lock(bundlePath, {
      realpath: false,
      stale,
      update,
      retries: {
        retries,
        factor: 1,
        minTimeout: retryDelay,
        maxTimeout: retryDelay,
        randomize: false,
      },
    });
  } catch (error) {
    if (error.code === "ELOCKED" || error.code === "ECOMPROMISED") {
      throw errors.lockTimeout(bundlePath);
    }
    throw error;
  }

  try {
    return await fn();
  } finally {
    await release();
  }
}
