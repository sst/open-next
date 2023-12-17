import type {
  InternalEvent,
  InternalResult,
  WrapperHandler,
} from "types/open-next";

import { MiddlewareOutputEvent } from "../core/routingHandler";

const handler: WrapperHandler<
  InternalEvent,
  InternalResult | ({ type: "middleware" } & MiddlewareOutputEvent)
> =
  async (handler, converter) =>
  async (event: Request): Promise<Response> => {
    const internalEvent = await converter.convertFrom(event);

    const response = await handler(internalEvent);

    const result: Response = converter.convertTo(response);

    return result;
  };

export default {
  wrapper: handler,
  name: "cloudflare",
  supportStreaming: true,
};
