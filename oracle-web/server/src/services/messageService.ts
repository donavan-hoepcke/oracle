import { randomUUID } from 'node:crypto';

export type SetupTag =
  | 'gap_and_go'
  | 'vwap_reclaim'
  | 'first_pullback'
  | 'orb_break'
  | 'red_to_green'
  | 'parabolic_extension'
  | 'news_pop'
  | 'halt_risk';

export interface MessageEventInput {
  text: string;
  channel?: string;
  author?: string;
  timestamp?: string;
}

export interface MessageEvent {
  id: string;
  text: string;
  channel: string;
  author: string;
  timestamp: string;
  symbols: string[];
  tags: SetupTag[];
  confidence: number;
}

export interface SymbolMessageContext {
  symbol: string;
  mentionCount: number;
  lastMentionAt: string | null;
  tagCounts: Partial<Record<SetupTag, number>>;
  convictionScore: number;
}

const TAG_RULES: Array<{ tag: SetupTag; pattern: RegExp }> = [
  { tag: 'gap_and_go', pattern: /\bgap\s*(and|n)?\s*go\b/i },
  { tag: 'vwap_reclaim', pattern: /\bvwap\s*(reclaim|reclaimed|hold|holding)\b/i },
  { tag: 'first_pullback', pattern: /\b(first\s+pullback|initial\s+pullback)\b/i },
  { tag: 'orb_break', pattern: /\b(orb\s*break|opening\s*range\s*break)\b/i },
  { tag: 'red_to_green', pattern: /\b(red\s*to\s*green|r2g)\b/i },
  { tag: 'parabolic_extension', pattern: /\b(parabolic|extended|overextended)\b/i },
  { tag: 'news_pop', pattern: /\b(news|pr|press\s+release|catalyst)\b/i },
  { tag: 'halt_risk', pattern: /\b(halt|halted|volatility\s*halt)\b/i },
];

const SYMBOL_STOPWORDS = new Set([
  'THE',
  'AND',
  'FOR',
  'WITH',
  'FROM',
  'THIS',
  'THAT',
  'NEWS',
  'VWAP',
  'LONG',
  'SHORT',
  'STOP',
  'SELL',
  'BUY',
  'ORB',
  'GAP',
  'GO',
  'SETUP',
  'WATCH',
  'BREAK',
  'FIRST',
  'POSSIBLE',
  'RISK',
  'PLAY',
  'OPEN',
  'CLOSE',
  'HIGH',
  'LOW',
  'IN',
  'OUT',
]);

class MessageService {
  private events: MessageEvent[] = [];
  private readonly maxEvents = 5000;

  ingest(input: MessageEventInput): MessageEvent {
    const text = (input.text ?? '').trim();
    const timestamp = input.timestamp ? new Date(input.timestamp) : new Date();
    const symbols = this.extractSymbols(text);
    const tags = this.extractTags(text);

    const confidence = Math.min(1, symbols.length * 0.25 + tags.length * 0.2 + (text.length > 60 ? 0.1 : 0));

    const event: MessageEvent = {
      id: randomUUID(),
      text,
      channel: input.channel?.trim() || 'general',
      author: input.author?.trim() || 'unknown',
      timestamp: timestamp.toISOString(),
      symbols,
      tags,
      confidence,
    };

    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    return event;
  }

  ingestMany(inputs: MessageEventInput[]): MessageEvent[] {
    return inputs.map((input) => this.ingest(input));
  }

  getRecent(limit = 100): MessageEvent[] {
    const clamped = Math.max(1, Math.min(limit, 1000));
    return this.events.slice(-clamped).reverse();
  }

  getSymbolContext(symbol: string, lookbackMs = 30 * 60 * 1000): SymbolMessageContext {
    const now = Date.now();
    const target = symbol.toUpperCase();

    const relevant = this.events.filter((evt) => {
      const ts = new Date(evt.timestamp).getTime();
      return now - ts <= lookbackMs && evt.symbols.includes(target);
    });

    const tagCounts: Partial<Record<SetupTag, number>> = {};
    for (const evt of relevant) {
      for (const tag of evt.tags) {
        tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      }
    }

    const convictionScore = this.computeConvictionScore(relevant.length, tagCounts);

    return {
      symbol: target,
      mentionCount: relevant.length,
      lastMentionAt: relevant.length > 0 ? relevant[relevant.length - 1].timestamp : null,
      tagCounts,
      convictionScore,
    };
  }

  private computeConvictionScore(
    mentions: number,
    tagCounts: Partial<Record<SetupTag, number>>
  ): number {
    const tagWeight = Object.values(tagCounts).reduce((sum, count) => sum + (count ?? 0), 0);
    return Math.min(100, mentions * 8 + tagWeight * 5);
  }

  private extractSymbols(text: string): string[] {
    const parsed = new Set<string>();
    const matches = text.toUpperCase().match(/\b[A-Z]{1,5}\b/g) ?? [];
    for (const match of matches) {
      if (!SYMBOL_STOPWORDS.has(match)) {
        parsed.add(match);
      }
    }
    return Array.from(parsed);
  }

  private extractTags(text: string): SetupTag[] {
    const tags: SetupTag[] = [];
    for (const rule of TAG_RULES) {
      if (rule.pattern.test(text)) {
        tags.push(rule.tag);
      }
    }
    return tags;
  }
}

export const messageService = new MessageService();
