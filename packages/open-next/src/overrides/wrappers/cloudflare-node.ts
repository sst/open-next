import type {
  InternalEvent,
  InternalResult,
  StreamCreator,
} from "types/open-next";
import type { Wrapper, WrapperHandler } from "types/overrides";

import { Writable } from "node:stream";

// Response with null body status (101, 204, 205, or 304) cannot have a body.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

const handler: WrapperHandler<InternalEvent, InternalResult> =
  async (handler, converter) =>
  async (
    request: Request,
    env: Record<string, string>,
    ctx: any,
    abortSignal: AbortSignal,
  ): Promise<Response> => {
    globalThis.process = process;
    // Set the environment variables
    // Cloudflare suggests to not override the process.env object but instead apply the values to it
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") {
        process.env[key] = value;
      }
    }

    const internalEvent = await converter.convertFrom(request);
    const url = new URL(request.url);

    const { promise: promiseResponse, resolve: resolveResponse } =
      Promise.withResolvers<Response>();

    const streamCreator: StreamCreator = {
      writeHeaders(prelude: {
        statusCode: number;
        cookies: string[];
        headers: Record<string, string>;
      }): Writable {
        const { statusCode, cookies, headers } = prelude;

        // TODO(vicb): this is a workaround to make PPR work with `wrangler dev`
        // See https://github.com/cloudflare/workers-sdk/issues/8004
        if (url.hostname === "localhost") {
          headers["content-encoding"] = "identity";
        }

        // Build headers array - set-cookie must be added separately for each cookie
        const headerEntries: [string, string][] = Object.entries(headers);
        for (const cookie of cookies) {
          headerEntries.push(["set-cookie", cookie]);
        }

        // Optimize: skip ReadableStream creation for null body statuses
        if (NULL_BODY_STATUSES.has(statusCode)) {
          const response = new Response(null, {
            status: statusCode,
            headers: responseHeaders,
          });
          resolveResponse(response);

          // Return a no-op Writable that discards all data
          return new Writable({
            write(chunk, encoding, callback) {
              callback();
            },
          });
        }

        let controller: ReadableStreamDefaultController<Uint8Array>;
        const readable = new ReadableStream({
          start(c) {
            controller = c;
          },
        });

        const response = new Response(readable, {
          status: statusCode,
          headers: headerEntries,
        });
        resolveResponse(response);

        return new Writable({
          write(chunk, encoding, callback) {
            try {
              controller.enqueue(chunk);
            } catch (e: any) {
              return callback(e);
            }
            callback();
          },
          final(callback) {
            controller.close();
            callback();
          },
          destroy(error, callback) {
            if (error) {
              controller.error(error);
            } else {
              try {
                controller.close();
              } catch {
                // Ignore "This ReadableStream is closed" error
              }
            }
            callback(error);
          },
        });
      },
      // This is for passing along the original abort signal from the initial Request you retrieve in your worker
      // Ensures that the response we pass to NextServer is aborted if the request is aborted
      // By doing this `request.signal.onabort` will work in route handlers
      abortSignal: abortSignal,
      // There is no need to retain the chunks that were pushed to the response stream.
      retainChunks: false,
    };

    ctx.waitUntil(
      handler(internalEvent, {
        streamCreator,
        waitUntil: ctx.waitUntil.bind(ctx),
      }),
    );

    return promiseResponse;
  };

export default {
  wrapper: handler,
  name: "cloudflare-node",
  supportStreaming: true,
} satisfies Wrapper;
