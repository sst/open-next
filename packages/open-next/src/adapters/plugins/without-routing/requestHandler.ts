import { InternalEvent } from "types/open-next";

import { MiddlewareOutputEvent } from "../../../core/routingHandler";
// This is available in requestHandler.ts
declare const internalEvent: InternalEvent;

//#override withRouting
// eslint-disable-next-line unused-imports/no-unused-vars
const preprocessResult: MiddlewareOutputEvent = {
  internalEvent: internalEvent,
  isExternalRewrite: false,
  headers: {},
};
//#endOverride
