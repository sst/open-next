export function removeUndefinedFromQuery(
  query: Record<string, string | string[] | undefined>,
) {
  const newQuery: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      newQuery[key] = value;
    }
  }
  return newQuery;
}
