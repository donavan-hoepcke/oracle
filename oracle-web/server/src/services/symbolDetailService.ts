import { StockState } from '../websocket/priceSocket.js';
import { ActiveTrade, FilterRejection, TradeLedgerEntry } from './executionService.js';
import { TradeCandidate } from './ruleEngineService.js';
import { FloatMapEntry, FloatMapSnapshot } from './floatMapService.js';
import {
  ModeratorAlertSnapshot,
  ModeratorBackup,
  ModeratorPost,
  ModeratorSignal,
} from './moderatorAlertService.js';
import { MessageEvent, SymbolMessageContext } from './messageService.js';
import { AlpacaPosition } from './alpacaOrderService.js';

export interface ModeratorBackupMention extends ModeratorBackup {
  postTitle: string;
  postedAt: string | null;
  author: string;
}

export interface ModeratorMention {
  title: string;
  kind: ModeratorPost['kind'];
  author: string;
  postedAt: string | null;
  role: 'primary' | 'backup' | 'mention';
  excerpt: string;
}

export interface SymbolDetail {
  symbol: string;
  asOf: string;
  inWatchlist: boolean;
  stockState: StockState | null;
  activeTrade:
    | (ActiveTrade & {
        currentPrice: number | null;
        unrealizedPl: number | null;
        rMultiple: number | null;
      })
    | null;
  position: AlpacaPosition | null;
  candidate: TradeCandidate | null;
  rejection: FilterRejection | null;
  cooldownExpiresAt: string | null;
  washSaleRisk: boolean;
  floatMap: FloatMapEntry | null;
  moderator: {
    primary: ModeratorSignal | null;
    primaryPost: {
      title: string;
      postedAt: string | null;
      author: string;
    } | null;
    backups: ModeratorBackupMention[];
    mentions: ModeratorMention[];
  };
  messageContext: SymbolMessageContext;
  recentMessages: MessageEvent[];
  closedTrades: TradeLedgerEntry[];
}

export interface SymbolDetailInputs {
  symbol: string;
  stocks: StockState[];
  candidates: TradeCandidate[];
  activeTrades: ActiveTrade[];
  rejections: FilterRejection[];
  cooldowns: Array<{ symbol: string; expiresAt: string }>;
  washSaleSymbols: string[];
  floatMap: FloatMapSnapshot;
  moderator: ModeratorAlertSnapshot;
  messageContext: SymbolMessageContext;
  recentMessages: MessageEvent[];
  ledger: TradeLedgerEntry[];
  positions: AlpacaPosition[];
  messageLookbackMs?: number;
}

function makeExcerpt(body: string, symbol: string): string {
  const needle = `$${symbol.toUpperCase()}`;
  const idx = body.toUpperCase().indexOf(needle.toUpperCase());
  if (idx < 0) {
    return body.slice(0, 160).trim();
  }
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + 160);
  const slice = body.slice(start, end).trim();
  return (start > 0 ? '... ' : '') + slice + (end < body.length ? ' ...' : '');
}

function collectModerator(symbol: string, moderator: ModeratorAlertSnapshot): SymbolDetail['moderator'] {
  const target = symbol.toUpperCase();
  let primary: ModeratorSignal | null = null;
  let primaryPost: SymbolDetail['moderator']['primaryPost'] = null;
  const backups: ModeratorBackupMention[] = [];
  const mentions: ModeratorMention[] = [];

  for (const post of moderator.posts) {
    let role: 'primary' | 'backup' | 'mention' | null = null;
    if (post.signal && post.signal.symbol.toUpperCase() === target) {
      if (!primary) {
        primary = post.signal;
        primaryPost = { title: post.title, postedAt: post.postedAt, author: post.author };
      }
      role = 'primary';
    }
    for (const b of post.backups) {
      if (b.symbol.toUpperCase() === target) {
        backups.push({
          ...b,
          postTitle: post.title,
          postedAt: post.postedAt,
          author: post.author,
        });
        if (!role) role = 'backup';
      }
    }
    if (!role) {
      const bodyHasTicker = post.body.toUpperCase().includes(`$${target}`);
      const titleHasTicker = post.title.toUpperCase().includes(target);
      if (bodyHasTicker || titleHasTicker) role = 'mention';
    }
    if (role) {
      mentions.push({
        title: post.title,
        kind: post.kind,
        author: post.author,
        postedAt: post.postedAt,
        role,
        excerpt: makeExcerpt(post.body, target),
      });
    }
  }

  return { primary, primaryPost, backups, mentions };
}

export function buildSymbolDetail(inputs: SymbolDetailInputs): SymbolDetail {
  const symbol = inputs.symbol.toUpperCase();
  const stockState = inputs.stocks.find((s) => s.symbol === symbol) ?? null;
  const candidate = inputs.candidates.find((c) => c.symbol === symbol) ?? null;
  const active = inputs.activeTrades.find((t) => t.symbol === symbol) ?? null;
  const position = inputs.positions.find((p) => p.symbol === symbol) ?? null;
  const rejection = inputs.rejections.find((r) => r.symbol === symbol) ?? null;
  const cooldown = inputs.cooldowns.find((c) => c.symbol === symbol) ?? null;
  const washSaleRisk = inputs.washSaleSymbols.includes(symbol);
  const floatMap = inputs.floatMap.entries.find((e) => e.symbol === symbol) ?? null;
  const moderator = collectModerator(symbol, inputs.moderator);
  const closedTrades = inputs.ledger.filter((l) => l.symbol === symbol);

  const currentPrice = position?.currentPrice ?? stockState?.currentPrice ?? null;
  let activeTrade: SymbolDetail['activeTrade'] = null;
  if (active) {
    const rMultiple =
      active.riskPerShare > 0 && currentPrice !== null
        ? (currentPrice - active.entryPrice) / active.riskPerShare
        : null;
    activeTrade = {
      ...active,
      currentPrice,
      unrealizedPl: position?.unrealizedPl ?? null,
      rMultiple,
    };
  }

  return {
    symbol,
    asOf: new Date().toISOString(),
    inWatchlist: stockState !== null,
    stockState,
    activeTrade,
    position,
    candidate,
    rejection,
    cooldownExpiresAt: cooldown?.expiresAt ?? null,
    washSaleRisk,
    floatMap,
    moderator,
    messageContext: inputs.messageContext,
    recentMessages: inputs.recentMessages,
    closedTrades,
  };
}
