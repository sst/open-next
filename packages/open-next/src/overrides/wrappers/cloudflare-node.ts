import type {
  InternalEvent,
  InternalResult,
  StreamCreator,
} from "types/open-next";
import type { Wrapper, WrapperHandler } from "types/overrides";

import { type Readable, Writable } from "node:stream";

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

    // writeHeaders resolves this once Next has chosen status/headers; the body is
    // streamed later through the Writable returned from streamCreator.
    let resolveResponse!: (response: Response) => void;
    const promiseResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });

    const streamCreator: StreamCreator = {
      writeHeaders(prelude: {
        statusCode: number;
        cookies: string[];
        headers: Record<string, string>;
      }): Writable {
        const { statusCode, cookies, headers } = prelude;

        const responseHeaders = new Headers(headers);
        for (const cookie of cookies) {
          responseHeaders.append("Set-Cookie", cookie);
        }

        // TODO(vicb): this is a workaround to make PPR work with `wrangler dev`
        // See https://github.com/cloudflare/workers-sdk/issues/8004
        if (url.hostname === "localhost") {
          responseHeaders.set("Content-Encoding", "identity");
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

        // Bridge Next's Node stream into Cloudflare's Web stream:
        // - Next writes chunks to the Writable below.
        // - Cloudflare reads chunks from the Response's ReadableStream.
        // - Each Node write callback is held until the Web stream pulls again,
        //   which propagates reader backpressure to the Node producer.
        let controller: ReadableStreamDefaultController<Uint8Array>;
        let controllerClosed = false;
        let producer: Readable | undefined;
        let completed = false;
        let destructionError: Error | undefined;
        let parkedWriteCallback:
          | ((error?: Error | null | undefined) => void)
          | undefined;

        // Completing the parked callback tells Node the previous write finished,
        // allowing a piped source to produce the next chunk.
        const settleParkedWrite = (error?: Error | null) => {
          const callback = parkedWriteCallback;
          parkedWriteCallback = undefined;
          callback?.(error);
        };

        const destroyProducer = () => {
          if (!completed && producer && !producer.destroyed) {
            producer.destroy();
          }
        };

        const closeController = () => {
          if (controllerClosed) {
            return;
          }
          controllerClosed = true;
          try {
            controller.close();
          } catch {
            // The Web stream may already have been closed by its consumer.
          }
        };

        const errorController = (error: Error) => {
          if (controllerClosed) {
            return;
          }
          controllerClosed = true;
          try {
            controller.error(error);
          } catch {
            // The Web stream may already have been closed by its consumer.
          }
        };

        const normalizeError = (reason: unknown) =>
          reason == null
            ? undefined
            : reason instanceof Error
              ? reason
              : new Error(String(reason));

        // pull() means the Response consumer has capacity for more data; use that
        // signal to release exactly one pending Node write.
        const readable = new ReadableStream({
          start(c) {
            controller = c;
          },
          pull() {
            settleParkedWrite();
          },
          cancel(reason) {
            // The response reader went away. Destroy the original producer too,
            // otherwise it may keep generating chunks into a closed bridge.
            controllerClosed = true;
            destructionError = normalizeError(reason);
            destroyProducer();
            bridge.destroy();
          },
        });

        const response = new Response(readable, {
          status: statusCode,
          headers: responseHeaders,
        });
        resolveResponse(response);

        const bridge = new Writable({
          // Keep the Writable queue small; backpressure is enforced by delaying
          // each write callback until the Web stream pulls again.
          highWaterMark: 1,
          write(chunk, encoding, callback) {
            if (controllerClosed) {
              callback(
                destructionError ?? new Error("Response stream is closed"),
              );
              return;
            }
            try {
              controller.enqueue(chunk);
            } catch (e: any) {
              callback(e);
              return;
            }
            // Do not call the callback yet: parking it pauses the Node producer
            // until pull() shows the Web stream wants another chunk.
            parkedWriteCallback = callback;
          },
          final(callback) {
            completed = true;
            closeController();
            callback();
          },
          destroy(error, callback) {
            destroyProducer();
            settleParkedWrite(error);
            if (error) {
              destructionError = error;
              errorController(error);
            } else {
              closeController();
            }
            callback(error);
          },
        });

        // The source Readable is only exposed through the pipe event; keep it so
        // Web stream cancellation can tear down upstream work.
        bridge.on("pipe", (source: Readable) => {
          producer = source;
          if (bridge.destroyed) {
            destroyProducer();
          }
        });

        return bridge;
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
