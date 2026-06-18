export function makeId(source: string, title: string): string {
  let hash = 0;
  const str = `${source}:${title}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return `x-${Math.abs(hash).toString(36)}`;
}
