import { InternalEvent, Origin } from "types/open-next";

import { debug, error } from "../adapters/logger";
import { createGenericHandler } from "../core/createGenericHandler";
import routingHandler from "../core/routingHandler";

const resolveOriginResolver = () => {
  const openNextParams = globalThis.openNextConfig.middleware;
  if (typeof openNextParams?.originResolver === "function") {
    return openNextParams.originResolver();
  } else {
    return Promise.resolve(async (_path: string) => {
      try {
        const origin = JSON.parse(
          process.env.OPEN_NEXT_ORIGIN ?? "{}",
        ) as Record<string, Origin>;
        for (const [key, value] of Object.entries(
          globalThis.openNextConfig.functions ?? {},
        )) {
          if (
            value.patterns.some((pattern) => {
              // Convert cloudfront pattern to regex
              return new RegExp(
                // transform glob pattern to regex
                "/" +
                  pattern
                    .replace(/\*\*/g, "(.*)")
                    .replace(/\*/g, "([^/]*)")
                    .replace(/\//g, "\\/")
                    .replace(/\?/g, "."),
              ).test(_path);
            })
          ) {
            debug("Using origin", key, value.patterns);
            return origin[key];
          }
        }
        if (origin["default"]) {
          debug("Using default origin", origin["default"]);
          return origin["default"];
        }
        return false as const;
      } catch (e) {
        error("Error while resolving origin", e);
        return false as const;
      }
    });
  }
};

const defaultHandler = async (internalEvent: InternalEvent) => {
  // TODO: We need to handle splitted function here
  // We should probably create an host resolver to redirect correctly
  const originResolver = await resolveOriginResolver();
  const result = await routingHandler(internalEvent);
  if ("internalEvent" in result) {
    debug("Middleware intercepted event", internalEvent);
    let origin: Origin | false = false;
    if (!result.isExternalRewrite) {
      origin = await originResolver(result.internalEvent.rawPath);
    }
    return {
      type: "middleware",
      internalEvent: result.internalEvent,
      headers: result.headers,
      isExternalRewrite: result.isExternalRewrite,
      origin,
    };
  } else {
    debug("Middleware response", result);
    return result;
  }
};

export const handler = await createGenericHandler({
  handler: defaultHandler,
  type: "middleware",
});

export default {
  fetch: handler,
};
