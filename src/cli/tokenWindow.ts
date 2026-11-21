export interface TokenWindow {
  readonly text: string;
  readonly total: number;
  readonly start: number;
  readonly end: number;
  readonly truncated: boolean;
}

// tokenx 1.3.0 uses this split expression before estimating and slicing.
// Its public API does not expose the segments, so retain the same boundaries
// here while mapping both ends of each segment to a disjoint text range.
// Segment estimation below inlines tokenx 1.3.0's `estimateSegmentTokens`
// (package.json pins tokenx to 1.3.0) so windowing splits the text once
// instead of re-splitting every segment through `estimateTokenCount`.
const TOKEN_SPLIT_PATTERN = /(\s+|[.,!?;(){}[\]<>:/\\|@#$%^&*+=`~_-]+)/;
const WHITESPACE_PATTERN = /^\s+$/;
const CJK_PATTERN =
  /[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\uFF00-\uFFEF\u30A0-\u30FF\u2E80-\u2EFF\u31C0-\u31EF\u3200-\u32FF\u3300-\u33FF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]/;
const NUMERIC_PATTERN = /^\d+(?:[.,]\d+)*$/;
const PUNCTUATION_PATTERN = /[.,!?;(){}[\]<>:/\\|@#$%^&*+=`~_-]/;
const DEFAULT_CHARS_PER_TOKEN = 6;
const SHORT_TOKEN_THRESHOLD = 3;
const LANGUAGE_CONFIGS = [
  { pattern: /[äöüßẞ]/i, averageCharsPerToken: 3 },
  { pattern: /[éèêëàâîïôûùüÿçœæáíóúñ]/i, averageCharsPerToken: 3 },
  { pattern: /[ąćęłńóśźżěščřžýůúďťň]/i, averageCharsPerToken: 3.5 },
] as const;

const languageCharsPerToken = (segment: string): number | undefined => {
  for (const config of LANGUAGE_CONFIGS)
    if (config.pattern.test(segment)) return config.averageCharsPerToken;
  return undefined;
};

/** tokenx 1.3.0 `estimateSegmentTokens` with default options, inlined. */
const estimateSegmentTokens = (segment: string): number => {
  if (WHITESPACE_PATTERN.test(segment)) return 0;
  if (CJK_PATTERN.test(segment)) return Array.from(segment).length;
  if (NUMERIC_PATTERN.test(segment)) return 1;
  if (segment.length <= SHORT_TOKEN_THRESHOLD) return 1;
  if (PUNCTUATION_PATTERN.test(segment))
    return segment.length > 1 ? Math.ceil(segment.length / 2) : 1;
  return Math.ceil(
    segment.length /
      (languageCharsPerToken(segment) ?? DEFAULT_CHARS_PER_TOKEN),
  );
};

const codePointSafeBoundary = (text: string, offset: number): number =>
  offset > 0 &&
  offset < text.length &&
  text.charCodeAt(offset - 1)! >= 0xd800 &&
  text.charCodeAt(offset - 1)! <= 0xdbff &&
  text.charCodeAt(offset)! >= 0xdc00 &&
  text.charCodeAt(offset)! <= 0xdfff
    ? offset - 1
    : offset;

const segmentBoundary = (
  segment: string,
  tokenOffset: number,
  tokenCount: number,
): number =>
  codePointSafeBoundary(
    segment,
    Math.floor((tokenOffset / tokenCount) * segment.length),
  );

/** Slice an approximate token range without overlapping pages or splitting a surrogate pair. */
export const sliceTextByTokenWindow = (
  text: string,
  offset: number,
  limit: number | undefined,
): TokenWindow => {
  // One split serves both the total and the window: each segment's token
  // count is estimated once and reused, instead of a full `estimateTokenCount`
  // pass plus a per-segment re-split.
  const segments = text.split(TOKEN_SPLIT_PATTERN).filter(Boolean);
  const counts = new Array<number>(segments.length);
  let total = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const count = estimateSegmentTokens(segments[index]!);
    counts[index] = count;
    total += count;
  }
  const end = limit === undefined ? total : offset + limit;
  if (offset === 0 && end >= total)
    return { text, total, start: 0, end: total, truncated: false };

  const actualEnd = Math.min(end, total);
  if (offset >= actualEnd)
    return {
      text: "",
      total,
      start: actualEnd,
      end: actualEnd,
      truncated: true,
    };

  const parts: string[] = [];
  let tokenPosition = 0;
  for (let index = 0; index < segments.length; index += 1) {
    if (tokenPosition >= actualEnd && actualEnd < total) break;
    const segment = segments[index]!;
    const tokenCount = counts[index]!;
    if (tokenCount === 0) {
      if (
        tokenPosition >= offset &&
        (tokenPosition < actualEnd || actualEnd === total)
      )
        parts.push(segment);
      continue;
    }

    const segmentEnd = tokenPosition + tokenCount;
    if (tokenPosition < actualEnd && segmentEnd > offset) {
      const localStart = Math.max(0, offset - tokenPosition);
      const localEnd = Math.min(tokenCount, actualEnd - tokenPosition);
      const charStart = segmentBoundary(segment, localStart, tokenCount);
      const charEnd = segmentBoundary(segment, localEnd, tokenCount);
      parts.push(segment.slice(charStart, charEnd));
    }
    tokenPosition = segmentEnd;
  }

  return {
    text: parts.join(""),
    total,
    start: offset,
    end: actualEnd,
    truncated: true,
  };
};
