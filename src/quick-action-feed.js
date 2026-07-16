import { projectQuickActions, stableStringify } from "./dashboard.js";
import { uploadOperatorBlob } from "./reporter.js";

export async function publishQuickActionFeed(config, states, {
  now = new Date(),
  upload = uploadOperatorBlob,
  abortSignal,
} = {}) {
  const feed = { generatedAt: now.toISOString(), actions: projectQuickActions(states) };
  const uploaded = await upload(config, "quick-actions.json", stableStringify(feed), "application/json; charset=utf-8", { abortSignal });
  if (uploaded === false) throw new Error("Quick-action feed upload was unavailable");
  return feed;
}

export function createQuickActionFeedPublisher(config, {
  loadStates,
  upload = uploadOperatorBlob,
  timeoutMs = 15_000,
} = {}) {
  let running = null;
  let requested = false;
  return () => {
    requested = true;
    if (running) return running;
    running = (async () => {
      while (requested) {
        requested = false;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("Quick-action feed upload timed out")), timeoutMs);
        try {
          await publishQuickActionFeed(config, await loadStates(), { upload, abortSignal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      }
    })().finally(() => { running = null; });
    return running;
  };
}
