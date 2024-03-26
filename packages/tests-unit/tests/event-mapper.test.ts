import { CloudFrontRequestResult } from "aws-lambda";

import { convertTo } from "../../open-next/src/adapters/event-mapper";

describe("convertTo", () => {
  describe("CloudFront Result", () => {
    it("Should parse the headers", () => {
      const response = convertTo({
        body: "",
        headers: {
          "content-type": "application/json",
          test: "test",
        },
        isBase64Encoded: false,
        statusCode: 200,
        type: "cf",
      }) as CloudFrontRequestResult;

      expect(response?.headers).toStrictEqual({
        "content-type": [
          {
            key: "content-type",
            value: "application/json",
          },
        ],
        test: [
          {
            key: "test",
            value: "test",
          },
        ],
      });
    });

    it("Should parse the headers with arrays", () => {
      const response = convertTo({
        body: "",
        headers: {
          test: ["test1", "test2"],
        },
        isBase64Encoded: false,
        statusCode: 200,
        type: "cf",
      }) as CloudFrontRequestResult;

      expect(response?.headers).toStrictEqual({
        test: [
          {
            key: "test",
            value: "test1",
          },
          {
            key: "test",
            value: "test2",
          },
        ],
      });
    });

    it("Should parse the headers with cookies", () => {
      const response = convertTo({
        body: "",
        headers: {
          "set-cookie":
            "test=1; Path=/; HttpOnly; Secure; SameSite=None, test=2; Path=/; HttpOnly; Secure; SameSite=None",
        },
        isBase64Encoded: false,
        statusCode: 200,
        type: "cf",
      }) as CloudFrontRequestResult;

      expect(response?.headers).toStrictEqual({
        "set-cookie": [
          {
            key: "set-cookie",
            value: "test=1; Path=/; HttpOnly; Secure; SameSite=None",
          },
          {
            key: "set-cookie",
            value: "test=2; Path=/; HttpOnly; Secure; SameSite=None",
          },
        ],
      });
    });

    it("Should parse the headers with cookies + expires", () => {
      const response = convertTo({
        body: "",
        headers: {
          "set-cookie":
            "test=1; Path=/; Expires=Sun, 14 Apr 2024 22:19:07 GMT; HttpOnly; Secure; SameSite=None, test=2; Path=/; Expires=Sun, 14 Apr 2024 22:19:07 GMT; HttpOnly; Secure; SameSite=None",
        },
        isBase64Encoded: false,
        statusCode: 200,
        type: "cf",
      }) as CloudFrontRequestResult;

      expect(response?.headers).toStrictEqual({
        "set-cookie": [
          {
            key: "set-cookie",
            value:
              "test=1; Path=/; Expires=Sun, 14 Apr 2024 22:19:07 GMT; HttpOnly; Secure; SameSite=None",
          },
          {
            key: "set-cookie",
            value:
              "test=2; Path=/; Expires=Sun, 14 Apr 2024 22:19:07 GMT; HttpOnly; Secure; SameSite=None",
          },
        ],
      });
    });

    describe("blacklisted headers", () => {
      it("should remove all blacklisted or read-only headers from the response", () => {
        const response = convertTo({
          body: "",
          headers: {
            Connection: "keep-alive",
            expect: "100-continue",
            "keep-Alive": "timeout=5, max=100",
            "Proxy-Authenticate": "Basic",
            "proxy-authorization": "Basic",
            "proxy-connection": "keep-alive",
            trailer: "Max-Forwards",
            Upgrade: "HTTP/2.0",
            "X-accel-buffering": "no",
            "X-accel-charset": "UTF-8",
            "x-accel-limit-rate": "1000",
            "X-accel-redirect": "http://example.com",
            "X-amz-cf-id": "example",
            "x-amzn-auth": "example",
            "x-Amzn-cf-billing": "example",
            "x-Amzn-cf-id": "example",
            "x-Amzn-Cf-xff": "example",
            "x-amzn-Errortype": "example",
            "x-amzn-fle-Profile": "example",
            "x-amzn-header-Count": "example",
            "x-amzn-Header-order": "example",
            "X-Amzn-Lambda-Integration-tag": "example",
            "x-amzn-Requestid": "example",
            "x-edge-Location": "example",
            "X-Cache": "Hit from cloudfront",
            "X-Forwarded-proto": "https",
            "x-Real-ip": "example",
            "Accept-encoding": "gzip",
            "content-length": "100",
            "if-modified-Since": "example",
            "if-none-match": "example",
            "if-range": "example",
            "if-unmodified-since": "example",
            "transfer-encoding": "example",
            via: "1.1 abc123.cloudfront.net (CloudFront)",
            "x-powered-by": "Next.js",
          },
          isBase64Encoded: false,
          statusCode: 200,
          type: "cf",
        }) as CloudFrontRequestResult;

        expect(response?.headers).toStrictEqual({
          "x-powered-by": [
            {
              key: "x-powered-by",
              value: "Next.js",
            },
          ],
        });
      });
    });
  });
});
