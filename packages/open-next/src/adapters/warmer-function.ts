import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

import { createGenericHandler } from "../core/createGenericHandler.js";
import { debug, error } from "./logger.js";
import { generateUniqueId } from "./util.js";

const lambda = new LambdaClient({});
const FUNCTION_NAME = process.env.FUNCTION_NAME!;
const CONCURRENCY = parseInt(process.env.CONCURRENCY!);

export interface WarmerEvent {
  type: "warmer";
  warmerId: string;
  index: number;
  concurrency: number;
  delay: number;
}

export interface WarmerResponse {
  type: "warmer";
  serverId: string;
}

const resolveWarmerInvoke = async () => {
  const openNextParams = globalThis.openNextConfig.warmer!;
  if (typeof openNextParams?.invokeFunction === "function") {
    return await openNextParams.invokeFunction();
  } else {
    return Promise.resolve(async (warmerId: string) => {
      const ret = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_v, i) => i).map((i) => {
          try {
            return lambda.send(
              new InvokeCommand({
                FunctionName: FUNCTION_NAME,
                InvocationType: "RequestResponse",
                Payload: Buffer.from(
                  JSON.stringify({
                    type: "warmer",
                    warmerId,
                    index: i,
                    concurrency: CONCURRENCY,
                    delay: 75,
                  } satisfies WarmerEvent),
                ),
              }),
            );
          } catch (e) {
            error(`failed to warm up #${i}`, e);
            // ignore error
          }
        }),
      );

      // Print status

      return ret
        .map((r, i) => {
          if (r?.StatusCode !== 200 || !r?.Payload) {
            error(`failed to warm up #${i}:`, r?.Payload?.toString());
            return;
          }
          const payload = JSON.parse(
            Buffer.from(r.Payload).toString(),
          ) as WarmerResponse;
          return {
            statusCode: r.StatusCode,
            payload,
            type: "warmer" as const,
          };
        })
        .filter((r): r is Exclude<typeof r, undefined> => !!r);
    });
  }
};

export const handler = await createGenericHandler({
  handler: defaultHandler,
  type: "warmer",
});

async function defaultHandler() {
  const warmerId = `warmer-${generateUniqueId()}`;
  debug({
    event: "warmer invoked",
    functionName: FUNCTION_NAME,
    concurrency: CONCURRENCY,
    warmerId,
  });

  const invokeFn = await resolveWarmerInvoke();

  const warmedServerIds = await invokeFn(warmerId);

  debug({
    event: "warmer result",
    sent: CONCURRENCY,
    success: warmedServerIds.length,
    uniqueServersWarmed: [...new Set(warmedServerIds)].length,
  });
  return {
    type: "warmer",
  };
}
