import { VALID_CAPTURE, VALID_STATUS } from "./constants.mjs";
import { isIsoDateTime } from "./time.mjs";
import { validateSelector } from "./selectors.mjs";
import { validateGitIdentity } from "./git-sources.mjs";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function issue(list, category, code, message, severity) {
  list.push({ category, code, message, severity });
}

function profileIssue(list, authoring, code, message) {
  issue(list, "profile", code, message, authoring ? "error" : "warning");
}

function validateActorEvent(value, field, codePrefix, issues, authoring) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    profileIssue(issues, authoring, `${codePrefix}-shape`, `${field} must be a mapping with by and at`);
    return;
  }
  if (!nonEmptyString(value.by)) {
    profileIssue(issues, authoring, `${codePrefix}-by`, `${field}.by must be a non-empty string`);
  }
  if (!isIsoDateTime(value.at)) {
    profileIssue(issues, authoring, `${codePrefix}-at`, `${field}.at must be an ISO 8601 datetime with offset`);
  }
}

function validateWindow(value, field, issues, authoring) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    profileIssue(issues, authoring, "usage-window-shape", `${field} must be a mapping with from and to`);
    return;
  }
  for (const key of ["from", "to"]) {
    if (!isIsoDateTime(value[key])) {
      profileIssue(issues, authoring, `usage-window-${key}`, `${field}.${key} must be an ISO 8601 datetime with offset`);
    }
  }
}

export function validateConcept(concept, { authoring = true } = {}) {
  const issues = [];
  const { data, body } = concept;

  if (!nonEmptyString(data.type)) {
    issue(issues, "conformance", "type-required", "type is required and must be a non-empty string", "error");
  }
  if (!nonEmptyString(data.title)) {
    profileIssue(issues, authoring, "title-required", "title is required by the Engram authoring profile");
  }
  if (!nonEmptyString(data.description)) {
    profileIssue(issues, authoring, "description-required", "description is required by the Engram authoring profile");
  }
  if (!body.trim()) {
    profileIssue(issues, authoring, "body-required", "a non-empty Markdown body is required by the Engram authoring profile");
  }

  if (data.status !== undefined && !VALID_STATUS.has(data.status)) {
    profileIssue(issues, authoring, "status-value", "status must be draft, stable, or deprecated");
  }
  if (data.tags !== undefined && (!Array.isArray(data.tags) || data.tags.some((tag) => !nonEmptyString(tag)))) {
    profileIssue(issues, authoring, "tags-shape", "tags must be a list of non-empty strings");
  }
  if (data.generated !== undefined) {
    validateActorEvent(data.generated, "generated", "generated", issues, authoring);
  } else {
    issue(issues, "profile", "generated-required", authoring
      ? "generated metadata will be added by Engram"
      : "generated metadata is recommended by the Engram profile", "warning");
  }

  if (data.verified !== undefined) {
    const events = Array.isArray(data.verified) ? data.verified : [data.verified];
    events.forEach((event, index) => validateActorEvent(
      event, `verified[${index}]`, "verified", issues, authoring,
    ));
  }
  if (data.stale_after !== undefined && !isIsoDateTime(data.stale_after)) {
    profileIssue(issues, authoring, "stale-after", "stale_after must be an ISO 8601 datetime with offset");
  }
  if (data.usage_window !== undefined) {
    validateWindow(data.usage_window, "usage_window", issues, authoring);
  }

  if (data.sources !== undefined) {
    if (!Array.isArray(data.sources)) {
      profileIssue(issues, authoring, "sources-shape", "sources must be a list");
    } else {
      const sourceIds = new Set();
      data.sources.forEach((source, index) => {
        const field = `sources[${index}]`;
        if (!source || typeof source !== "object" || Array.isArray(source)) {
          profileIssue(issues, authoring, "source-shape", `${field} must be a mapping`);
          return;
        }
        if (!nonEmptyString(source.resource)) {
          profileIssue(issues, authoring, "source-resource", `${field}.resource is required`);
        }
        if (source.id !== undefined && !nonEmptyString(source.id)) {
          profileIssue(issues, authoring, "source-id", `${field}.id must be a non-empty string`);
        } else if (source.id !== undefined) {
          if (sourceIds.has(source.id)) {
            profileIssue(issues, authoring, "source-id-duplicate", `${field}.id duplicates another source ID`);
          }
          sourceIds.add(source.id);
        }
        if (source.author !== undefined && !nonEmptyString(source.author)) {
          profileIssue(issues, authoring, "source-author", `${field}.author must be a non-empty string`);
        }
        if (source.digest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(source.digest)) {
          profileIssue(issues, authoring, "source-digest", `${field}.digest must be sha256:<64 lowercase hex characters>`);
        }
        if (source.selector !== undefined) {
          try {
            validateSelector(source.selector);
          } catch (error) {
            profileIssue(issues, authoring, "source-selector", `${field}.${error.message}`);
          }
        }
        if (source.git !== undefined) {
          if (!nonEmptyString(source.id)) {
            profileIssue(issues, authoring, "source-git-id", `${field}.id is required for pinned-source resolution`);
          }
          if (!/^sha256:[0-9a-f]{64}$/.test(source.digest ?? "")) {
            profileIssue(issues, authoring, "source-git-digest", `${field}.digest is required for pinned-source verification`);
          }
          try {
            validateGitIdentity(source.git);
          } catch (error) {
            profileIssue(issues, authoring, "source-git", `${field}.${error.message}`);
          }
        }
        if (source.last_modified !== undefined && !isIsoDateTime(source.last_modified)) {
          profileIssue(issues, authoring, "source-last-modified", `${field}.last_modified must be an ISO 8601 datetime with offset`);
        }
        if (source.usage_count !== undefined && (!Number.isInteger(source.usage_count) || source.usage_count < 0)) {
          profileIssue(issues, authoring, "source-usage-count", `${field}.usage_count must be a non-negative integer`);
        }
        if (source.usage_window !== undefined) {
          validateWindow(source.usage_window, `${field}.usage_window`, issues, authoring);
        }
      });
    }
  }

  if (data.type === "Memory") {
    if (!VALID_CAPTURE.has(data.capture)) {
      profileIssue(issues, authoring, "memory-capture", "Memory capture must be explicit or inferred");
    }
    if (!Array.isArray(data.sources) || data.sources.length === 0) {
      profileIssue(issues, authoring, "memory-source", "Memory has no conversation provenance source");
    }
  } else if (data.capture !== undefined) {
    issue(issues, "profile", "capture-type", "capture is normally used only on Memory concepts", "warning");
  }

  const errors = issues.filter((item) => item.severity === "error").map((item) => item.message);
  const warnings = issues.filter((item) => item.severity === "warning").map((item) => item.message);
  return { errors, warnings, issues, valid: errors.length === 0 };
}
