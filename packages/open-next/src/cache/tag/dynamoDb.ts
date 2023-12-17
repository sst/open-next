import {
  BatchWriteItemCommand,
  DynamoDBClient,
  DynamoDBClientConfig,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import path from "path";

import { MAX_DYNAMO_BATCH_WRITE_ITEM_COUNT } from "../../adapters/constants";
import { awsLogger, debug, error } from "../../adapters/logger";
import { chunk, parseNumberFromEnv } from "../../adapters/util";
import { TagCache } from "./types";

const { CACHE_BUCKET_REGION, CACHE_DYNAMO_TABLE, NEXT_BUILD_ID } = process.env;

function parseDynamoClientConfigFromEnv(): DynamoDBClientConfig {
  return {
    region: CACHE_BUCKET_REGION,
    logger: awsLogger,
    maxAttempts: parseNumberFromEnv(process.env.AWS_SDK_DYNAMODB_MAX_ATTEMPTS),
  };
}

const dynamoClient = new DynamoDBClient(parseDynamoClientConfigFromEnv());

function buildDynamoKey(key: string) {
  // FIXME: We should probably use something else than path.join here
  // this could transform some fetch cache key into a valid path
  return path.posix.join(NEXT_BUILD_ID ?? "", key);
}

function buildDynamoObject(path: string, tags: string, revalidatedAt?: number) {
  return {
    path: { S: buildDynamoKey(path) },
    tag: { S: buildDynamoKey(tags) },
    revalidatedAt: { N: `${revalidatedAt ?? Date.now()}` },
  };
}

const tagCache: TagCache = {
  async getByPath(path) {
    try {
      if (globalThis.disableDynamoDBCache) return [];
      const result = await dynamoClient.send(
        new QueryCommand({
          TableName: CACHE_DYNAMO_TABLE,
          IndexName: "revalidate",
          KeyConditionExpression: "#key = :key",
          ExpressionAttributeNames: {
            "#key": "path",
          },
          ExpressionAttributeValues: {
            ":key": { S: buildDynamoKey(path) },
          },
        }),
      );
      const tags = result.Items?.map((item) => item.tag.S ?? "") ?? [];
      debug("tags for path", path, tags);
      return tags;
    } catch (e) {
      error("Failed to get tags by path", e);
      return [];
    }
  },
  async getByTag(tag) {
    try {
      if (globalThis.disableDynamoDBCache) return [];
      const { Items } = await dynamoClient.send(
        new QueryCommand({
          TableName: CACHE_DYNAMO_TABLE,
          KeyConditionExpression: "#tag = :tag",
          ExpressionAttributeNames: {
            "#tag": "tag",
          },
          ExpressionAttributeValues: {
            ":tag": { S: buildDynamoKey(tag) },
          },
        }),
      );
      return (
        // We need to remove the buildId from the path
        Items?.map(
          ({ path: { S: key } }) => key?.replace(`${NEXT_BUILD_ID}/`, "") ?? "",
        ) ?? []
      );
    } catch (e) {
      error("Failed to get by tag", e);
      return [];
    }
  },
  async getLastModified(key, lastModified) {
    try {
      if (globalThis.disableDynamoDBCache) return lastModified ?? Date.now();
      const result = await dynamoClient.send(
        new QueryCommand({
          TableName: CACHE_DYNAMO_TABLE,
          IndexName: "revalidate",
          KeyConditionExpression:
            "#key = :key AND #revalidatedAt > :lastModified",
          ExpressionAttributeNames: {
            "#key": "path",
            "#revalidatedAt": "revalidatedAt",
          },
          ExpressionAttributeValues: {
            ":key": { S: buildDynamoKey(key) },
            ":lastModified": { N: String(lastModified ?? 0) },
          },
        }),
      );
      const revalidatedTags = result.Items ?? [];
      debug("revalidatedTags", revalidatedTags);
      // If we have revalidated tags we return -1 to force revalidation
      return revalidatedTags.length > 0 ? -1 : lastModified ?? Date.now();
    } catch (e) {
      error("Failed to get revalidated tags", e);
      return lastModified ?? Date.now();
    }
  },
  async writeTags(tags) {
    try {
      if (globalThis.disableDynamoDBCache) return;
      await Promise.all(
        chunk(tags, MAX_DYNAMO_BATCH_WRITE_ITEM_COUNT).map((Items) => {
          return dynamoClient.send(
            new BatchWriteItemCommand({
              RequestItems: {
                [CACHE_DYNAMO_TABLE ?? ""]: Items.map((Item) => ({
                  PutRequest: {
                    Item: {
                      ...buildDynamoObject(
                        Item.path,
                        Item.tag,
                        Item.revalidatedAt,
                      ),
                    },
                  },
                })),
              },
            }),
          );
        }),
      );
    } catch (e) {
      error("Failed to batch write dynamo item", e);
    }
  },
};

export default tagCache;
