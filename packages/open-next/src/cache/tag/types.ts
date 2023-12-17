export type TagCache = {
  getByTag(tag: string): Promise<string[]>;
  getByPath(path: string): Promise<string[]>;
  getLastModified(path: string, lastModified?: number): Promise<number>;
  writeTags(
    tags: { tag: string; path: string; revalidatedAt?: number }[],
  ): Promise<void>;
};
