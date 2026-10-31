import type { SourceRef } from './types';

/** Presentation only: the source file and its commercial terms stay untouched. */
export function presentationMarkdown(content: string): string {
  let body = content.replace(/^\uFEFF/, '');
  body = body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  return body.replace(/^\s*# [^\r\n]*(?:\r?\n|$)/, '').trim();
}

/** Navigate only to explicitly registered sources; other links keep their normal behavior. */
export function registeredSourceForHref(documentPath: string, href: string, sources: SourceRef[]): string | undefined {
  if (!href || href.startsWith('#')) return undefined;
  try {
    const base = new URL('file:///');
    base.pathname = documentPath;
    const target = new URL(href, base);
    if (target.protocol !== 'file:' || target.host) return undefined;
    const path = decodeURIComponent(target.pathname);
    return sources.find(source => source.path === path)?.id;
  } catch { return undefined; }
}
