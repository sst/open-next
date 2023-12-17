import {
  IncomingMessage,
  OpenNextNodeResponse,
  StreamCreator,
} from "http/index.js";
import { InternalEvent, InternalResult } from "types/open-next";

import { debug, error } from "../adapters/logger";
import { convertRes, createServerResponse, proxyRequest } from "./routing/util";
import routingHandler from "./routingHandler";
import { requestHandler, setNextjsPrebundledReact } from "./util";

export async function openNextHandler(
  internalEvent: InternalEvent,
  responseStreaming?: StreamCreator,
): Promise<InternalResult> {
  if (internalEvent.headers["x-forwarded-host"]) {
    internalEvent.headers.host = internalEvent.headers["x-forwarded-host"];
  }
  debug("internalEvent", internalEvent);

  //#override withRouting
  const preprocessResult = await routingHandler(internalEvent);
  //#endOverride

  if ("type" in preprocessResult) {
    // res is used only in the streaming case
    const headers = preprocessResult.headers;
    const res = createServerResponse(internalEvent, headers, responseStreaming);
    res.statusCode = preprocessResult.statusCode;
    res.flushHeaders();
    res.write(preprocessResult.body);
    res.end();
    return preprocessResult;
  } else {
    const preprocessedEvent = preprocessResult.internalEvent;
    debug("preprocessedEvent", preprocessedEvent);
    const reqProps = {
      method: preprocessedEvent.method,
      url: preprocessedEvent.url,
      //WORKAROUND: We pass this header to the serverless function to mimic a prefetch request which will not trigger revalidation since we handle revalidation differently
      // There is 3 way we can handle revalidation:
      // 1. We could just let the revalidation go as normal, but due to race condtions the revalidation will be unreliable
      // 2. We could alter the lastModified time of our cache to make next believe that the cache is fresh, but this could cause issues with stale data since the cdn will cache the stale data as if it was fresh
      // 3. OUR CHOICE: We could pass a purpose prefetch header to the serverless function to make next believe that the request is a prefetch request and not trigger revalidation (This could potentially break in the future if next changes the behavior of prefetch requests)
      headers: { ...preprocessedEvent.headers, purpose: "prefetch" },
      body: preprocessedEvent.body,
      remoteAddress: preprocessedEvent.remoteAddress,
    };
    const req = new IncomingMessage(reqProps);
    const res = createServerResponse(
      preprocessedEvent,
      preprocessResult.headers as Record<string, string | string[]>,
      responseStreaming,
    );

    await processRequest(
      req,
      res,
      preprocessedEvent,
      preprocessResult.isExternalRewrite,
    );

    const { statusCode, headers, isBase64Encoded, body } = convertRes(res);

    const internalResult = {
      type: internalEvent.type,
      statusCode,
      headers,
      body,
      isBase64Encoded,
    };

    return internalResult;
  }
}

async function processRequest(
  req: IncomingMessage,
  res: OpenNextNodeResponse,
  internalEvent: InternalEvent,
  isExternalRewrite?: boolean,
) {
  // @ts-ignore
  // Next.js doesn't parse body if the property exists
  // https://github.com/dougmoscrop/serverless-http/issues/227
  delete req.body;

  try {
    // `serverHandler` is replaced at build time depending on user's
    // nextjs version to patch Nextjs 13.4.x and future breaking changes.

    const { rawPath } = internalEvent;

    if (isExternalRewrite) {
      return proxyRequest(internalEvent, res);
    } else {
      //#override applyNextjsPrebundledReact
      setNextjsPrebundledReact(rawPath);
      //#endOverride

      // Next Server
      await requestHandler(req, res);
    }
  } catch (e: any) {
    error("NextJS request failed.", e);
    //TODO: we could return the next 500 page here
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        {
          message: "Server failed to respond.",
          details: e,
        },
        null,
        2,
      ),
    );
  }
}
