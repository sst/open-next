import { OutgoingHttpHeader, OutgoingHttpHeaders } from "http";
import { Transform, TransformCallback, Writable } from "stream";

import { convertHeader, parseCookies, parseHeaders } from "./util";

const SET_COOKIE_HEADER = "set-cookie";

export interface StreamCreator {
  writeHeaders(prelude: {
    statusCode: number;
    cookies: string[];
    headers: Record<string, string>;
  }): Writable;
  // Just to fix an issue with aws lambda streaming with empty body
  onWrite?: () => void;
  onFinish: () => void;
}

// We only need to implement the methods that are used by next.js
export class OpenNextNodeResponse extends Transform {
  statusCode: number | undefined;
  statusMessage: string | undefined;
  headers: OutgoingHttpHeaders = {};
  private _cookies: string[] = [];
  private responseStream?: Writable;
  headersSent: boolean = false;
  _chunks: Buffer[] = [];

  constructor(
    private fixHeaders: (headers: OutgoingHttpHeaders) => void,
    onEnd: (headers: OutgoingHttpHeaders) => Promise<void>,
    private streamCreator?: StreamCreator,
    private initialHeaders?: OutgoingHttpHeaders,
  ) {
    super();
    if (initialHeaders && initialHeaders[SET_COOKIE_HEADER]) {
      this._cookies = parseCookies(
        initialHeaders[SET_COOKIE_HEADER] as string | string[],
      ) as string[];
    }
    this.once("finish", () => {
      if (!this.headersSent) {
        this.flushHeaders();
      }
      onEnd(this.headers);
      this.streamCreator?.onFinish();
    });
  }

  get finished() {
    return this.writableFinished && this.responseStream?.writableFinished;
  }

  setHeader(name: string, value: string | string[]): this {
    const key = name.toLowerCase();
    if (key === SET_COOKIE_HEADER) {
      this._cookies.push(convertHeader(value));
      this.headers[key] = this._cookies;
    } else {
      this.headers[key] = value;
    }

    return this;
  }

  removeHeader(name: string): this {
    const key = name.toLowerCase();
    if (key === SET_COOKIE_HEADER) {
      this._cookies = [];
    } else {
      delete this.headers[key];
    }
    return this;
  }

  hasHeader(name: string): boolean {
    const key = name.toLowerCase();
    if (key === SET_COOKIE_HEADER) {
      return this._cookies.length > 0;
    }
    return this.headers[key] !== undefined;
  }

  getHeaders(): OutgoingHttpHeaders {
    return this.headers;
  }

  getHeader(name: string): OutgoingHttpHeader | undefined {
    return this.headers[name.toLowerCase()];
  }

  // Only used directly in next@14+
  flushHeaders() {
    this.headersSent = true;
    this.fixHeaders(this.headers);
    if (this.initialHeaders) {
      this.headers = {
        ...this.headers,
        ...this.initialHeaders,
      };
    }

    if (this.streamCreator) {
      this.responseStream = this.streamCreator?.writeHeaders({
        statusCode: this.statusCode ?? 200,
        cookies: this._cookies,
        headers: parseHeaders(this.headers),
      });
      this.pipe(this.responseStream);
    }
  }

  // Might be used in next page api routes
  writeHead(statusCode: number, headers?: OutgoingHttpHeaders): this {
    this.statusCode = statusCode;
    if (headers) {
      this.headers = headers;
    }
    this.flushHeaders();
    return this;
  }

  get body() {
    return Buffer.concat(this._chunks);
  }

  private _internalWrite(chunk: any, encoding: BufferEncoding) {
    this._chunks.push(Buffer.from(chunk, encoding));
    this.push(chunk, encoding);
    this.streamCreator?.onWrite?.();
  }

  _transform(
    chunk: any,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    if (!this.headersSent) {
      this.flushHeaders();
    }
    this._internalWrite(chunk, encoding);
    callback();
  }
}
