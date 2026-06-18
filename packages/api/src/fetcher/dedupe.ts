export function createDedupe() {
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const seenSnippets = new Set<string>();

  return {
    isDuplicate(post: { id: string; url: string | null; text: string }): boolean {
      const snippet = post.text.slice(0, 100).toLowerCase();
      const dup =
        seenIds.has(post.id) ||
        (post.url !== null && seenUrls.has(post.url)) ||
        (post.url === null && snippet !== '' && seenSnippets.has(snippet));
      seenIds.add(post.id);
      if (post.url !== null) seenUrls.add(post.url);
      if (snippet !== '') seenSnippets.add(snippet);
      return dup;
    },
  };
}
