/*eslint-disable simple-import-sort/imports */
import type { Options, PluginHandler } from "../../types/next-types.js";
import type { IncomingMessage } from "../../http/request.js";
//#override imports
//@ts-ignore
import { requestHandler } from "./util.js";
//@ts-ignore
import { proxyRequest } from "./routing/util.js";
import { OpenNextNodeResponse } from "../../http/openNextResponse.js";
//#endOverride

//#override handler
export const handler: PluginHandler = async (
  req: IncomingMessage,
  res: OpenNextNodeResponse,
  options: Options,
) => {
  if (options.isExternalRewrite) {
    return proxyRequest(req, res);
  } else {
    // Next Server
    return requestHandler(req, res);
  }
};
//#endOverride
