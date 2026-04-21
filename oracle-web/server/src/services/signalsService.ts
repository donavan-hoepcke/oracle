import { ModeratorAlertSnapshot } from './moderatorAlertService.js';
import { MessageEvent, SetupTag } from './messageService.js';
import { TradeCandidate, CandidateSetup } from './ruleEngineService.js';

export type SignalKind = 'candidate' | 'moderator_primary' | 'moderator_backup' | 'community_hot';

export interface SignalInboxItem {
  id: string;
  kind: SignalKind;
  symbol: string;
  headline: string;
  priority: number;
  occurredAt: string | null;
  details: {
    // candidate
    score?: number;
    setup?: CandidateSetup;
    suggestedEntry?: number;
    suggestedStop?: number;
    suggestedTarget?: number;
    rationale?: string[];
    // moderator
    signal?: number | null;
    riskZone?: number | null;
    target?: string | null;
    postTitle?: string;
    author?: string;
    note?: string | null;
    // community
    mentionCount?: number;
    convictionScore?: number;
    topTags?: SetupTag[];
  };
}

export interface SignalsInputs {
  candidates: TradeCandidate[];
  moderator: ModeratorAlertSnapshot;
  recentMessages: MessageEvent[];
  communityLookbackMs?: number;
  communityMinMentions?: number;
  communityMinConviction?: number;
  now?: number;
}

function candidatePriority(score: number): number {
  if (score >= 80) return 90;
  if (score >= 60) return 70;
  return 50;
}

function setupLabel(setup: CandidateSetup): string {
  return setup.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
}

function candidateItem(c: TradeCandidate): SignalInboxItem {
  return {
    id: `candidate:${c.symbol}`,
    kind: 'candidate',
    symbol: c.symbol,
    headline: `${setupLabel(c.setup)} · score ${c.score.toFixed(0)}`,
    priority: candidatePriority(c.score),
    occurredAt: null,
    details: {
      score: c.score,
      setup: c.setup,
      suggestedEntry: c.suggestedEntry,
      suggestedStop: c.suggestedStop,
      suggestedTarget: c.suggestedTarget,
      rationale: c.rationale,
    },
  };
}

function moderatorPrimaryItems(moderator: ModeratorAlertSnapshot): SignalInboxItem[] {
  const items: SignalInboxItem[] = [];
  for (const post of moderator.posts) {
    if (!post.signal) continue;
    const priceText = post.signal.signal !== null ? `$${post.signal.signal.toFixed(2)}` : 'n/a';
    items.push({
      id: `mod_primary:${post.signal.symbol}:${post.postedAt ?? post.title}`,
      kind: 'moderator_primary',
      symbol: post.signal.symbol.toUpperCase(),
      headline: `Moderator alert · signal ${priceText}`,
      priority: 100,
      occurredAt: post.postedAt,
      details: {
        signal: post.signal.signal,
        riskZone: post.signal.riskZone,
        target: post.signal.target,
        postTitle: post.title,
        author: post.author,
      },
    });
  }
  return items;
}

function moderatorBackupItems(moderator: ModeratorAlertSnapshot): SignalInboxItem[] {
  const items: SignalInboxItem[] = [];
  for (const post of moderator.posts) {
    for (const b of post.backups) {
      const priceText = b.price !== null ? `$${b.price.toFixed(2)}` : 'n/a';
      items.push({
        id: `mod_backup:${b.symbol}:${post.postedAt ?? post.title}`,
        kind: 'moderator_backup',
        symbol: b.symbol.toUpperCase(),
        headline: `Moderator backup · ${priceText}${b.note ? ` — ${b.note}` : ''}`,
        priority: 40,
        occurredAt: post.postedAt,
        details: {
          signal: b.price,
          postTitle: post.title,
          author: post.author,
          note: b.note,
        },
      });
    }
  }
  return items;
}

function communityHotItems(
  messages: MessageEvent[],
  opts: { lookbackMs: number; minMentions: number; minConviction: number; now: number },
): SignalInboxItem[] {
  const { lookbackMs, minMentions, minConviction, now } = opts;
  const perSymbol = new Map<
    string,
    { count: number; lastTs: number; tags: Map<SetupTag, number> }
  >();
  for (const msg of messages) {
    const ts = new Date(msg.timestamp).getTime();
    if (!Number.isFinite(ts) || now - ts > lookbackMs) continue;
    for (const sym of msg.symbols) {
      const entry = perSymbol.get(sym) ?? { count: 0, lastTs: 0, tags: new Map() };
      entry.count += 1;
      entry.lastTs = Math.max(entry.lastTs, ts);
      for (const tag of msg.tags) {
        entry.tags.set(tag, (entry.tags.get(tag) ?? 0) + 1);
      }
      perSymbol.set(sym, entry);
    }
  }

  const items: SignalInboxItem[] = [];
  for (const [symbol, entry] of perSymbol.entries()) {
    const tagTotal = Array.from(entry.tags.values()).reduce((sum, n) => sum + n, 0);
    const conviction = Math.min(100, entry.count * 8 + tagTotal * 5);
    if (entry.count < minMentions && conviction < minConviction) continue;
    const topTags = Array.from(entry.tags.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tag]) => tag);
    items.push({
      id: `community:${symbol}:${entry.lastTs}`,
      kind: 'community_hot',
      symbol,
      headline: `Community · ${entry.count} mention${entry.count === 1 ? '' : 's'} · conviction ${conviction.toFixed(0)}`,
      priority: conviction >= 50 ? 30 : 20,
      occurredAt: new Date(entry.lastTs).toISOString(),
      details: {
        mentionCount: entry.count,
        convictionScore: conviction,
        topTags,
      },
    });
  }
  return items;
}

export function buildSignalsInbox(inputs: SignalsInputs): SignalInboxItem[] {
  const now = inputs.now ?? Date.now();
  const lookbackMs = inputs.communityLookbackMs ?? 30 * 60 * 1000;
  const minMentions = inputs.communityMinMentions ?? 3;
  const minConviction = inputs.communityMinConviction ?? 40;

  const items: SignalInboxItem[] = [
    ...inputs.candidates.map(candidateItem),
    ...moderatorPrimaryItems(inputs.moderator),
    ...moderatorBackupItems(inputs.moderator),
    ...communityHotItems(inputs.recentMessages, {
      lookbackMs,
      minMentions,
      minConviction,
      now,
    }),
  ];

  items.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const ta = a.occurredAt ? new Date(a.occurredAt).getTime() : 0;
    const tb = b.occurredAt ? new Date(b.occurredAt).getTime() : 0;
    return tb - ta;
  });

  return items;
}
