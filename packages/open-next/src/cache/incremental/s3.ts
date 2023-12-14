import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ClientConfig,
} from "@aws-sdk/client-s3";
import path from "path";

import { awsLogger } from "../../adapters/logger";
import { parseNumberFromEnv } from "../../adapters/util";
import { Extension } from "../next-types";
import { IncrementalCache } from "./types";

const {
  CACHE_BUCKET_REGION,
  CACHE_BUCKET_KEY_PREFIX,
  NEXT_BUILD_ID,
  CACHE_BUCKET_NAME,
} = process.env;

function parseS3ClientConfigFromEnv(): S3ClientConfig {
  return {
    region: CACHE_BUCKET_REGION,
    logger: awsLogger,
    maxAttempts: parseNumberFromEnv(process.env.AWS_SDK_S3_MAX_ATTEMPTS),
  };
}

const s3Client = new S3Client(parseS3ClientConfigFromEnv());

function buildS3Key(key: string, extension: Extension) {
  return path.posix.join(
    CACHE_BUCKET_KEY_PREFIX ?? "",
    extension === "fetch" ? "__fetch" : "",
    NEXT_BUILD_ID ?? "",
    extension === "fetch" ? key : `${key}.${extension}`,
  );
}

const incrementalCache: IncrementalCache = {
  async get(key, isFetch) {
    const result = await s3Client.send(
      new GetObjectCommand({
        Bucket: CACHE_BUCKET_NAME,
        Key: buildS3Key(key, isFetch ? "fetch" : "cache"),
      }),
    );

    const cacheData = JSON.parse(
      (await result.Body?.transformToString()) ?? "{}",
    );
    return {
      value: cacheData,
      lastModified: result.LastModified?.getTime(),
    };
  },
  async set(key, value, isFetch): Promise<void> {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: CACHE_BUCKET_NAME,
        Key: buildS3Key(key, isFetch ? "fetch" : "cache"),
        Body: JSON.stringify(value),
      }),
    );
  },
  async delete(key): Promise<void> {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: CACHE_BUCKET_NAME,
        Key: buildS3Key(key, "cache"),
      }),
    );
  },
};

export default incrementalCache;
