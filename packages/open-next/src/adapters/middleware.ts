import { InternalEvent } from "types/open-next";

import { createGenericHandler } from "../core/createGenericHandler";
import routingHandler from "../core/routingHandler";

const defaultHandler = async (internalEvent: InternalEvent) => {
  // TODO: We need to handle splitted function here
  // We should probably create an host resolver to redirect correctly
  const result = await routingHandler(internalEvent);
  if ("internalEvent" in result) {
    return {
      type: "middleware",
      internalEvent: result.internalEvent,
      headers: result.headers,
      isExternalRewrite: result.isExternalRewrite,
    };
  } else {
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
