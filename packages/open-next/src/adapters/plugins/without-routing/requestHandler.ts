import { InternalEvent } from "types/open-next";

import { MiddlewareOutputEvent } from "../../../core/routingHandler";
// This is available in requestHandler.ts
declare const internalEvent: InternalEvent;

//#override withRouting
const overwrittenResponseHeaders = Object.entries(internalEvent.headers).reduce(
  (acc, [key, value]) => {
    if (!key.startsWith("x-middleware-response-")) {
      return acc;
    }
    return { ...acc, [key.replace("x-middleware-response-", "")]: value };
  },
  {},
);
const preprocessResult: MiddlewareOutputEvent = {
  internalEvent: internalEvent,
  isExternalRewrite: false,
  headers: overwrittenResponseHeaders,
  origin: false,
};
//#endOverride

// We need to export something otherwise when compiled in js it creates an empty export {} inside the override
export default {};
