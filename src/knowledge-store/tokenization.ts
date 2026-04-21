const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'from',
  'in',
  'on',
  'at',
  'for',
  'with',
  'and',
  'or',
  'but',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'flow',
  'test',
  'should',
  'can',
  'will',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'this',
  'that',
  'these',
  'those',
  'it',
  'mm',
  'mcp',
  'lw',
]);

const MIN_TOKEN_LENGTH = 2;

/**
 * Tokenizes text into lowercase words, removing stopwords.
 *
 * @param text - The text to tokenize.
 * @returns Array of unique lowercase tokens.
 */
export function tokenize(text: string): string[] {
  if (!text) {
    return [];
  }

  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/iu)
    .filter(
      (token) => token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token),
    );

  return [...new Set(tokens)];
}

/**
 * Tokenizes a camelCase/PascalCase identifier into words.
 *
 * @param identifier - The identifier to tokenize.
 * @returns Array of unique lowercase tokens.
 */
export function tokenizeIdentifier(identifier: string): string[] {
  if (!identifier) {
    return [];
  }

  const withSpaces = identifier
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2');

  const tokens = withSpaces
    .toLowerCase()
    .split(/[^a-z0-9]+/iu)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);

  return [...new Set(tokens)];
}

const ACTION_SYNONYMS: Record<string, string[]> = {
  send: ['transfer', 'pay'],
  receive: ['deposit'],
  approve: ['confirm', 'accept', 'allow'],
  reject: ['deny', 'cancel', 'decline'],
  unlock: ['login', 'signin'],
  connect: ['link', 'authorize'],
  swap: ['exchange', 'trade'],
  sign: ['signature'],
};

/**
 * Expands tokens by adding action-related synonyms.
 *
 * @param tokens - The tokens to expand.
 * @returns Expanded array including synonyms.
 */
export function expandWithSynonyms(tokens: string[]): string[] {
  const expanded = new Set(tokens);

  for (const token of tokens) {
    if (ACTION_SYNONYMS[token]) {
      for (const synonym of ACTION_SYNONYMS[token]) {
        expanded.add(synonym);
      }
    }

    for (const [canonical, synonyms] of Object.entries(ACTION_SYNONYMS)) {
      if (synonyms.includes(token)) {
        expanded.add(canonical);
        for (const synonym of synonyms) {
          expanded.add(synonym);
        }
      }
    }
  }

  return [...expanded];
}
