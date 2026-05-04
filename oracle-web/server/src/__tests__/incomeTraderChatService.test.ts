import { describe, it, expect } from 'vitest';
import {
  parseIncomeTraderTickers,
  parseIncomeTraderChat,
} from '../services/incomeTraderChatService.js';

describe('parseIncomeTraderTickers', () => {
  it('parses both sections from the right-rail innerText layout', () => {
    const text = [
      'page chrome',
      'random nav links',
      "Today's Tickers",
      'MODERATOR PICKS',
      'SMHI',
      '1.59%',
      '$1230.25',
      '$ELPH',
      '0%',
      '$0',
      '$UAVS',
      '11.85%',
      '$0.79',
      'COMMUNITY MENTIONS',
      '$SCWX',
      '1.59%',
      '$1.91',
      '$ATM',
      '1.92%',
      '$4.96',
    ].join('\n');

    const { moderatorPicks, communityMentions } = parseIncomeTraderTickers(text);

    expect(moderatorPicks).toHaveLength(3);
    expect(moderatorPicks[0]).toEqual({
      symbol: 'SMHI',
      changePct: 1.59,
      price: 1230.25,
      section: 'moderator_pick',
    });
    expect(moderatorPicks[1].symbol).toBe('ELPH');
    expect(moderatorPicks[1].price).toBe(0);

    expect(communityMentions).toHaveLength(2);
    expect(communityMentions[0]).toEqual({
      symbol: 'SCWX',
      changePct: 1.59,
      price: 1.91,
      section: 'community_mention',
    });
  });

  it('ignores pre-anchor cashtags so chat $TICKER mentions do not leak into picks', () => {
    const text = [
      'henrySpps',
      'May 4 11:14 AM',
      'Watching $AAPL into the open',
      "Today's Tickers",
      'MODERATOR PICKS',
      'WULF',
      '5.85%',
      '$30.24',
    ].join('\n');

    const { moderatorPicks, communityMentions } = parseIncomeTraderTickers(text);
    expect(moderatorPicks).toHaveLength(1);
    expect(moderatorPicks[0].symbol).toBe('WULF');
    expect(communityMentions).toHaveLength(0);
  });

  it('returns empty when the rail anchor is absent', () => {
    const text = 'just some chat\nmore chat\n$AAPL\n5%\n$200';
    const { moderatorPicks, communityMentions } = parseIncomeTraderTickers(text);
    expect(moderatorPicks).toHaveLength(0);
    expect(communityMentions).toHaveLength(0);
  });

  it('dedupes a symbol that appears twice within the same scrape', () => {
    const text = [
      "Today's Tickers",
      'MODERATOR PICKS',
      'PN',
      '5%',
      '$6.01',
      'PN',
      '5%',
      '$6.01',
    ].join('\n');
    const { moderatorPicks } = parseIncomeTraderTickers(text);
    expect(moderatorPicks).toHaveLength(1);
  });
});

describe('parseIncomeTraderChat', () => {
  it('extracts each message anchored on its timestamp line', () => {
    const text = [
      'header chrome',
      'henrySpps',
      'May 4 11:14 AM',
      'Taking the loss of the day off.',
      'Body line 2.',
      'Blanker',
      'May 4 11:18 AM',
      'Great call',
      "Today's Tickers",
      'MODERATOR PICKS',
      'PN',
      '5%',
      '$6.01',
    ].join('\n');

    const messages = parseIncomeTraderChat(text);
    expect(messages).toHaveLength(2);
    expect(messages[0].author).toBe('henrySpps');
    expect(messages[0].body).toBe('Taking the loss of the day off.\nBody line 2.');
    // We treat page-rendered times as UTC literals (no TZ shift); consumers
    // re-zone if they need ET. See comment on parseChatTimestamp.
    expect(messages[0].postedAt).toMatch(/T11:14:00\.000Z$/);
    expect(messages[1].author).toBe('Blanker');
    expect(messages[1].body).toBe('Great call');
  });

  it('does not pull right-rail rows in as chat messages', () => {
    const text = [
      'henrySpps',
      'May 4 11:14 AM',
      'normal chat',
      "Today's Tickers",
      'MODERATOR PICKS',
      'PN',
      '5%',
      '$6.01',
    ].join('\n');
    const messages = parseIncomeTraderChat(text);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe('normal chat');
  });

  it('handles "May 4, 2026 8:43 AM" full-year format', () => {
    const text = [
      'Caleb · ETT Admin',
      'May 4, 2026 8:43 AM',
      'Daily Market Profits Alert 5-4-2026',
    ].join('\n');
    const messages = parseIncomeTraderChat(text);
    expect(messages).toHaveLength(1);
    expect(messages[0].author).toBe('Caleb · ETT Admin');
  });
});
