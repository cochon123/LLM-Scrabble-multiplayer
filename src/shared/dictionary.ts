function normalizeWord(word: string): string {
  return word
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();
}

export class Dictionary {
  private readonly words: Set<string>;
  private readonly list: string[];

  constructor(content: string) {
    const uniqueWords = new Set(
      content
        .split(/\r?\n/)
        .map((line) => normalizeWord(line))
        .filter(Boolean)
    );
    this.words = uniqueWords;
    this.list = [...uniqueWords].sort((a, b) => b.length - a.length || a.localeCompare(b));
  }

  has(word: string): boolean {
    return this.words.has(normalizeWord(word));
  }

  getWords(): string[] {
    return this.list;
  }

  count(): number {
    return this.words.size;
  }

  normalize(word: string): string {
    return normalizeWord(word);
  }
}
