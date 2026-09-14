import { Writable } from "node:stream";
import { ReadableStream } from "node:stream/web";

import { openNextHandler } from "@opennextjs/aws/core/requestHandler.js";
import routingHandler from "@opennextjs/aws/core/routingHandler.js";
import type {
  InternalEvent,
  InternalResult,
  StreamCreator,
} from "@opennextjs/aws/types/open-next.js";
import { beforeEach, vi } from "vitest";

vi.mock("@opennextjs/aws/adapters/config/index.js", () => ({
  BuildId: "build-id",
  HtmlPages: [],
  NextConfig: {},
}));

vi.mock("@opennextjs/aws/core/routingHandler.js", () => ({
  default: vi.fn(),
  INTERNAL_EVENT_REQUEST_ID: "x-opennext-request-id",
  INTERNAL_HEADER_INITIAL_URL: "x-opennext-initial-url",
  INTERNAL_HEADER_RESOLVED_ROUTES: "x-opennext-resolved-routes",
  INTERNAL_HEADER_REWRITE_STATUS_CODE: "x-opennext-rewrite-status-code",
  MIDDLEWARE_HEADER_PREFIX: "x-middleware-response-",
  MIDDLEWARE_HEADER_PREFIX_LEN: "x-middleware-response-".length,
}));

vi.mock("@opennextjs/aws/core/util.js", () => ({
  requestHandler: vi.fn(),
  setNextjsPrebundledReact: vi.fn(),
}));

const mockedRoutingHandler = vi.mocked(routingHandler);
const event: InternalEvent = {
  type: "core",
  method: "GET",
  rawPath: "/",
  url: "https://example.com/",
  body: Buffer.alloc(0),
  headers: {},
  query: {},
  cookies: {},
  remoteAddress: "::1",
};

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) {
      return;
    }
    await nextTurn();
  }
  throw new Error("Timed out waiting for condition");
}

function createBody(total: number) {
  let produced = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced >= total) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(64 * 1024);
      chunk[0] = produced++;
      controller.enqueue(chunk);
    },
  });

  return {
    body,
    get produced() {
      return produced;
    },
  };
}

function createResult(body: ReadableStream<Uint8Array>): InternalResult {
  return {
    type: "core",
    statusCode: 200,
    headers: {},
    body,
    isBase64Encoded: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.openNextConfig = {};
  globalThis.__next_route_preloader = vi.fn(async () => {});
});

describe("requestHandler streaming", () => {
  it("retains a tee branch and remains bounded when chunks do not need retaining", async () => {
    const source = createBody(20);
    const tee = vi.spyOn(source.body, "tee");
    const result = createResult(source.body);
    mockedRoutingHandler.mockResolvedValue(result);

    const writeCallbacks: Array<() => void> = [];
    const received: number[] = [];
    const streamCreator: StreamCreator = {
      retainChunks: false,
      writeHeaders: () =>
        new Writable({
          highWaterMark: 1,
          write(chunk: Buffer, _encoding, callback) {
            received.push(chunk[0]);
            writeCallbacks.push(callback);
          },
        }),
    };

    const handlerPromise = openNextHandler(event, { streamCreator });
    await waitFor(() => writeCallbacks.length > 0);
    await nextTurn();
    const producedWhileStalled = source.produced;
    for (let i = 0; i < 25; i++) {
      await nextTurn();
    }

    expect(source.produced).toBe(producedWhileStalled);
    expect(source.produced).toBeLessThan(20);
    expect(tee).toHaveBeenCalledOnce();

    while (received.length < 20) {
      await waitFor(() => writeCallbacks.length > 0);
      writeCallbacks.shift()!();
    }

    const returned = await handlerPromise;
    expect(returned).toBe(result);
    expect(received).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(returned.body).not.toBe(source.body);
    expect((await new Response(returned.body).arrayBuffer()).byteLength).toBe(
      20 * 64 * 1024,
    );
    expect(source.body.locked).toBe(true);
  });

  it("retains a tee branch by default", async () => {
    const source = createBody(3);
    const tee = vi.spyOn(source.body, "tee");
    const result = createResult(source.body);
    mockedRoutingHandler.mockResolvedValue(result);

    const streamed: Buffer[] = [];
    const streamCreator: StreamCreator = {
      writeHeaders: () =>
        new Writable({
          write(chunk, _encoding, callback) {
            streamed.push(chunk);
            callback();
          },
        }),
    };

    const returned = await openNextHandler(event, { streamCreator });

    expect(tee).toHaveBeenCalledOnce();
    expect(returned.body).not.toBe(source.body);
    expect(Buffer.concat(streamed).length).toBe(3 * 64 * 1024);
    expect((await new Response(returned.body).arrayBuffer()).byteLength).toBe(
      3 * 64 * 1024,
    );
  });
});
