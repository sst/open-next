import { Readable, type Writable } from "node:stream";
import { finished } from "node:stream/promises";

import cloudflareNode from "@opennextjs/aws/overrides/wrappers/cloudflare-node.js";
import type {
  InternalEvent,
  InternalResult,
} from "@opennextjs/aws/types/open-next.js";
import type {
  Converter,
  OpenNextHandler,
} from "@opennextjs/aws/types/overrides.js";

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

const emptyResult: InternalResult = {
  type: "core",
  statusCode: 200,
  headers: {},
  body: new ReadableStream(),
  isBase64Encoded: false,
};

const converter = {
  name: "test",
  convertFrom: async () => event,
  convertTo: async () => undefined,
} satisfies Converter;

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

function createProducer(total = Number.POSITIVE_INFINITY) {
  let produced = 0;
  let destroyedWith: Error | null | undefined;
  const producer = new Readable({
    highWaterMark: 1,
    read() {
      if (produced >= total) {
        this.push(null);
        return;
      }
      this.push(Buffer.from([produced++]));
    },
    destroy(error, callback) {
      destroyedWith = error;
      callback(error);
    },
  });

  return {
    producer,
    get produced() {
      return produced;
    },
    get destroyedWith() {
      return destroyedWith;
    },
  };
}

async function startResponse(producer: Readable) {
  let destination: Writable | undefined;
  let handlerPromise: Promise<InternalResult> | undefined;
  const handler: OpenNextHandler = async (_event, options) => {
    destination = options?.streamCreator?.writeHeaders({
      statusCode: 200,
      cookies: [],
      headers: {},
    });
    if (!destination) {
      throw new Error("Missing stream destination");
    }
    producer.pipe(destination);
    await finished(destination);
    return emptyResult;
  };

  const wrapped = await cloudflareNode.wrapper(handler, converter);
  const response = await wrapped(
    new Request("https://example.com/"),
    {},
    {
      waitUntil(promise: Promise<InternalResult>) {
        handlerPromise = promise;
        promise.catch(() => {});
      },
    },
    new AbortController().signal,
  );

  if (!destination || !handlerPromise) {
    throw new Error("Wrapper did not start streaming");
  }

  return { destination, handlerPromise, response };
}

describe("cloudflare-node wrapper streaming", () => {
  it("bounds production and delivers chunks in order to a slow consumer", async () => {
    const source = createProducer(32);
    const { handlerPromise, response } = await startResponse(source.producer);

    await waitFor(() => source.produced > 0);
    await nextTurn();
    const producedWhileIdle = source.produced;
    for (let i = 0; i < 25; i++) {
      await nextTurn();
    }

    expect(source.produced).toBe(producedWhileIdle);
    expect(source.produced).toBeLessThan(32);

    const reader = response.body!.getReader();
    const received: number[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received.push(value[0]);
      expect(source.produced).toBeLessThanOrEqual(received.length + 3);
      await nextTurn();
    }

    await expect(handlerPromise).resolves.toBe(emptyResult);
    expect(received).toEqual(Array.from({ length: 32 }, (_, index) => index));
  });

  it("cancels the bridge and its producer while settling the handler", async () => {
    const source = createProducer();
    const { destination, handlerPromise, response } = await startResponse(
      source.producer,
    );
    const reader = response.body!.getReader();

    await reader.read();
    const cancellation = new Error("consumer cancelled");
    await reader.cancel(cancellation);

    await expect(handlerPromise).rejects.toMatchObject({
      code: "ERR_STREAM_PREMATURE_CLOSE",
    });
    expect(destination.destroyed).toBe(true);
    expect(source.producer.destroyed).toBe(true);
    expect(source.destroyedWith).toBeNull();
  });

  it("destroys the producer and errors the Web response when destroyed", async () => {
    const source = createProducer();
    const { destination, handlerPromise, response } = await startResponse(
      source.producer,
    );
    const destruction = new Error("bridge destroyed");

    destination.destroy(destruction);

    await expect(handlerPromise).rejects.toThrow("bridge destroyed");
    await expect(response.text()).rejects.toThrow("bridge destroyed");
    expect(source.producer.destroyed).toBe(true);
    expect(source.destroyedWith).toBeNull();
  });
});
