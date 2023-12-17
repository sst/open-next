import { readFileSync } from "fs";

import { createGenericHandler } from "../core/createGenericHandler.js";
import { resolveTagCache } from "../core/resolve.js";
import {
  getDynamoBatchWriteCommandConcurrency,
  MAX_DYNAMO_BATCH_WRITE_ITEM_COUNT,
} from "./constants.js";
import { chunk } from "./util.js";

const PHYSICAL_RESOURCE_ID = "dynamodb-cache" as const;

//TODO: modify this, we should use the same format as the cache
type DataType = {
  tag: {
    S: string;
  };
  path: {
    S: string;
  };
  revalidatedAt: {
    N: string;
  };
};

interface InitializationFunctionEvent {
  type: "initializationFunction";
  requestType: "create" | "update" | "delete";
  resourceId: typeof PHYSICAL_RESOURCE_ID;
}

const tagCache = await resolveTagCache(
  globalThis.openNextConfig?.initializationFunction?.tagCache,
);

export const handler = await createGenericHandler({
  handler: defaultHandler,
  type: "initializationFunction",
});

async function defaultHandler(
  event: InitializationFunctionEvent,
): Promise<InitializationFunctionEvent> {
  switch (event.requestType) {
    case "create":
    case "update":
      return insert(event.requestType);
    case "delete":
      return remove();
  }
}

async function insert(
  requestType: InitializationFunctionEvent["requestType"],
): Promise<InitializationFunctionEvent> {
  const file = readFileSync(`dynamodb-cache.json`, "utf8");

  const data: DataType[] = JSON.parse(file);

  const parsedData = data.map((item) => ({
    tag: item.tag.S,
    path: item.path.S,
    revalidatedAt: parseInt(item.revalidatedAt.N),
  }));

  const dataChunks = chunk(parsedData, MAX_DYNAMO_BATCH_WRITE_ITEM_COUNT);

  const paramsChunks = chunk(
    dataChunks,
    getDynamoBatchWriteCommandConcurrency(),
  );

  for (const paramsChunk of paramsChunks) {
    await Promise.all(paramsChunk.map((params) => tagCache.writeTags(params)));
  }

  return {
    type: "initializationFunction",
    requestType,
    resourceId: PHYSICAL_RESOURCE_ID,
  };
}

async function remove(): Promise<InitializationFunctionEvent> {
  // Do we want to actually delete anything here?
  return {
    type: "initializationFunction",
    requestType: "delete",
    resourceId: PHYSICAL_RESOURCE_ID,
  };
}
