import yaml from 'js-yaml';

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Split a markdown document into its YAML frontmatter (parsed as an object)
 * and the remaining body. Documents without a leading `---` block return an
 * empty `data` object and the original markdown as `body`. Pure function: no
 * filesystem access.
 */
export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const match = markdown.match(FRONTMATTER_PATTERN);
  if (!match) {
    return { data: {}, body: markdown };
  }
  const parsed = yaml.load(match[1] ?? '');
  const data =
    parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  return { data, body: markdown.slice(match[0].length) };
}
