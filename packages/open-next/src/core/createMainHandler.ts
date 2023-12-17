import type { BuildOptions, OverrideOptions } from "types/open-next";

import { debug } from "../adapters/logger";
import type { IncrementalCache } from "../cache/incremental/types";
import type { Queue } from "../queue/types";
import { openNextHandler } from "./requestHandler";
import { resolveConverter, resolveTagCache, resolveWrapper } from "./resolve";

declare global {
  var queue: Queue;
  var incrementalCache: IncrementalCache;
}

async function resolveQueue(queue: OverrideOptions["queue"]) {
  if (typeof queue === "string") {
    const m = await import(`../queue/${queue}.js`);
    return m.default;
  } else if (typeof queue === "function") {
    return queue();
  } else {
    const m_1 = await import("../queue/sqs.js");
    return m_1.default;
  }
}

async function resolveIncrementalCache(
  incrementalCache: OverrideOptions["incrementalCache"],
) {
  if (typeof incrementalCache === "string") {
    const m = await import(`../cache/incremental/${incrementalCache}.js`);
    return m.default;
  } else if (typeof incrementalCache === "function") {
    return incrementalCache();
  } else {
    const m_1 = await import("../cache/incremental/s3.js");
    return m_1.default;
  }
}

export async function createMainHandler() {
  //First we load the config
  const config: BuildOptions = await import(
    process.cwd() + "/open-next.config.js"
  ).then((m) => m.default);

  const thisFunction = config.functions.default;

  // Default queue
  globalThis.queue = await resolveQueue(thisFunction.override?.queue);

  globalThis.incrementalCache = await resolveIncrementalCache(
    thisFunction.override?.incrementalCache,
  );

  globalThis.tagCache = await resolveTagCache(thisFunction.override?.tagCache);

  // From the config, we create the adapter
  const adapter = await resolveConverter(thisFunction.override?.converter);

  // Then we create the handler
  const wrapper = await resolveWrapper(thisFunction.override?.wrapper);

  debug("Using wrapper", wrapper.name);

  return wrapper.wrapper(openNextHandler, adapter);
}
