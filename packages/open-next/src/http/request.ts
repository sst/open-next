// Copied and modified from serverless-http by Doug Moscrop
// https://github.com/dougmoscrop/serverless-http/blob/master/lib/request.js
// Licensed under the MIT License

// @ts-nocheck
import http from "node:http";

export class IncomingMessage extends http.IncomingMessage {
  constructor({
    method,
    url,
    headers,
    body,
    remoteAddress,
  }: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: Buffer;
    remoteAddress: string;
  }) {
    super({
      encrypted: true,
      readable: false,
      remoteAddress,
      address: () => ({ port: 443 }),
      end: Function.prototype,
      destroy: Function.prototype,
    });

    if (typeof headers["content-length"] === "undefined") {
      headers["content-length"] = Buffer.byteLength(body).toString();
    }

    Object.assign(this, {
      ip: remoteAddress,
      complete: true,
      httpVersion: "1.1",
      httpVersionMajor: "1",
      httpVersionMinor: "1",
      method,
      headers,
      body,
      url,
    });

    this._read = () => {
      this.push(body);
      this.push(null);
    };
  }
}
