import { createGenericHandler } from "../core/createGenericHandler.js";
import { debug, error } from "./logger.js";
import { generateUniqueId } from "./util.js";

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
      const { InvokeCommand, LambdaClient } = await import(
        "@aws-sdk/client-lambda"
      );
      const lambda = new LambdaClient({});
      const warmParams = JSON.parse(process.env.WARM_PARAMS!) as {
        concurrency: number;
        function: string;
      }[];

      for (const warmParam of warmParams) {
        const { concurrency: CONCURRENCY, function: FUNCTION_NAME } = warmParam;
        debug({
          event: "warmer invoked",
          functionName: FUNCTION_NAME,
          concurrency: CONCURRENCY,
          warmerId,
        });
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

        const warmedServerIds = ret
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

        debug({
          event: "warmer result",
          sent: CONCURRENCY,
          success: warmedServerIds.length,
          uniqueServersWarmed: [...new Set(warmedServerIds)].length,
        });
      }
    });
  }
};

export const handler = await createGenericHandler({
  handler: defaultHandler,
  type: "warmer",
});

async function defaultHandler() {
  const warmerId = `warmer-${generateUniqueId()}`;

  const invokeFn = await resolveWarmerInvoke();

  await invokeFn(warmerId);

  return {
    type: "warmer",
  };
}
