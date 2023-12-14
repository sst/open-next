import type {
  APIGatewayProxyEvent,
  APIGatewayProxyEventV2,
  APIGatewayProxyResult,
  APIGatewayProxyResultV2,
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
} from "aws-lambda";
import type { WrapperHandler } from "types/open-next";

import { WarmerEvent, WarmerResponse } from "../adapters/warmer-function";

type AwsLambdaEvent =
  | APIGatewayProxyEventV2
  | CloudFrontRequestEvent
  | APIGatewayProxyEvent
  | WarmerEvent;

type AwsLambdaReturn =
  | APIGatewayProxyResultV2
  | APIGatewayProxyResult
  | CloudFrontRequestResult
  | WarmerResponse;

function formatWarmerResponse(event: WarmerEvent) {
  return new Promise<WarmerResponse>((resolve) => {
    setTimeout(() => {
      resolve({ serverId, type: "warmer" } satisfies WarmerResponse);
    }, event.delay);
  });
}

const handler: WrapperHandler =
  async (handler, converter) =>
  async (event: AwsLambdaEvent): Promise<AwsLambdaReturn> => {
    // Handle warmer event
    if ("type" in event) {
      return formatWarmerResponse(event);
    }

    const internalEvent = await converter.convertFrom(event);

    const response = await handler(internalEvent);

    return converter.convertTo(response, event);
  };

export default {
  wrapper: handler,
  name: "aws-lambda",
  supportStreaming: false,
};
