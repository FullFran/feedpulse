export function canonicalizeArticleLink(link: string | null | undefined): string | null {
  if (typeof link !== 'string') {
    return null;
  }

  const trimmed = link.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = '';

    const normalizedPath = parsed.pathname.replace(/\/{2,}/g, '/');
    parsed.pathname = normalizedPath === '/' ? '/' : normalizedPath.replace(/\/+$/g, '');

    return parsed.toString();
  } catch {
    const withoutFragment = trimmed.split('#')[0]?.trim() ?? '';
    if (!withoutFragment) {
      return null;
    }

    return withoutFragment.endsWith('/') ? withoutFragment.replace(/\/+$/g, '') : withoutFragment;
  }
}
