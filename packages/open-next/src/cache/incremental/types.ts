import { Meta } from "../next-types";

export type S3CachedFile =
  | {
      type: "redirect";
      props?: Object;
      meta?: Meta;
    }
  | {
      type: "page";
      html: string;
      json: Object;
      meta?: Meta;
    }
  | {
      type: "app";
      html: string;
      rsc: string;
      meta?: Meta;
    }
  | {
      type: "route";
      body: string;
      meta?: Meta;
    };

export type S3FetchCache = Object;

export type WithLastModified<T> = {
  lastModified?: number;
  value?: T;
};

export type CacheValue<IsFetch extends boolean> = IsFetch extends true
  ? S3FetchCache
  : S3CachedFile;

export type IncrementalCache = {
  get<IsFetch extends boolean = false>(
    key: string,
    isFetch?: IsFetch,
  ): Promise<WithLastModified<CacheValue<IsFetch>>>;
  set<IsFetch extends boolean = false>(
    key: string,
    value: CacheValue<IsFetch>,
    isFetch?: IsFetch,
  ): Promise<void>;
  delete(key: string): Promise<void>;
};
