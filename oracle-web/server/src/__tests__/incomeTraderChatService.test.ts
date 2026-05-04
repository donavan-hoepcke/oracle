import { describe, it, expect } from 'vitest';
import {
  parseIncomeTraderTickers,
  parseIncomeTraderChat,
} from '../services/incomeTraderChatService.js';

describe('parseIncomeTraderTickers', () => {
  it('parses both sections in the four-line $SYMBOL/count/pct/price layout', () => {
    // Mirrors the live innerText format: each section header is followed by
    // a section-total integer, then per-symbol rows of $SYMBOL / count /
    // signed pct / $price.
    const text = [
      'page chrome',
      "Today's Tickers",
      'MODERATOR PICKS',
      '9',
      '$SNDK',
      '2',
      '+2.71%',
      '$1240.74',
      '$ELPW',
      '1',
      '+69.91%',
      '$7.51',
      '$AKAN',
      '1',
      '-4.59%',
      '$41.29',
      'COMMUNITY MENTIONS',
      '51',
      '$CNSP',
      '47',
      '-20.08%',
      '$7.70',
      '$ATM',
      '1',
      '+1.92%',
      '$4.96',
    ].join('\n');

    const { moderatorPicks, communityMentions } = parseIncomeTraderTickers(text);

    expect(moderatorPicks).toHaveLength(3);
    expect(moderatorPicks[0]).toEqual({
      symbol: 'SNDK',
      changePct: 2.71,
      price: 1240.74,
      section: 'moderator_pick',
    });
    expect(moderatorPicks[2]).toEqual({
      symbol: 'AKAN',
      changePct: -4.59,
      price: 41.29,
      section: 'moderator_pick',
    });

    expect(communityMentions).toHaveLength(2);
    expect(communityMentions[0]).toEqual({
      symbol: 'CNSP',
      changePct: -20.08,
      price: 7.7,
      section: 'community_mention',
    });
  });

  it('handles rows with missing pct and price (rail shows just $SYM and count)', () => {
    const text = [
      "Today's Tickers",
      'MODERATOR PICKS',
      '2',
      '$SHSH',
      '1',
      '$IWM',
      '1',
      '-0.31%',
      '$278.00',
    ].join('\n');

    const { moderatorPicks } = parseIncomeTraderTickers(text);
    expect(moderatorPicks).toHaveLength(2);
    expect(moderatorPicks[0]).toEqual({
      symbol: 'SHSH',
      changePct: null,
      price: null,
      section: 'moderator_pick',
    });
    expect(moderatorPicks[1].symbol).toBe('IWM');
    expect(moderatorPicks[1].price).toBe(278);
  });

  it('ignores pre-anchor cashtags so chat $TICKER mentions do not leak into picks', () => {
    const text = [
      'henrySpps',
      'May 4, 11:14 AM',
      'Watching $AAPL into the open',
      "Today's Tickers",
      'MODERATOR PICKS',
      '1',
      '$WULF',
      '1',
      '+5.85%',
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
});

describe('parseIncomeTraderChat', () => {
  it('extracts ordinary "May 4, 11:14 AM" messages anchored on the timestamp', () => {
    // The live transcript uses a comma after the day for ordinary messages;
    // the year-only variant is reserved for moderator alert posts.
    const text = [
      'header chrome',
      'henrySpps',
      'May 4, 11:14 AM',
      'Taking the loss of the day off.',
      'Body line 2.',
      'Blanker',
      'May 4, 11:18 AM',
      'Great call',
      "Today's Tickers",
      'MODERATOR PICKS',
      '1',
      '$PN',
      '1',
      '+5%',
      '$6.01',
    ].join('\n');

    const messages = parseIncomeTraderChat(text);
    expect(messages).toHaveLength(2);
    expect(messages[0].author).toBe('henrySpps');
    expect(messages[0].body).toBe('Taking the loss of the day off.\nBody line 2.');
    expect(messages[0].postedAt).toMatch(/T11:14:00\.000Z$/);
    expect(messages[1].author).toBe('Blanker');
    expect(messages[1].body).toBe('Great call');
  });

  it('uses the line above the "·" separator as the author for moderator messages', () => {
    // Mirrors the live layout where Tim Bohen's alert puts a "·" line
    // between the author name and the timestamp.
    const text = [
      'Tim Bohen',
      '·',
      'May 4, 2026 9:43 AM',
      'Daily Market Profits Alert 5-4-2026',
      '$PN(5.39/+88.13%)',
      'planetdarr',
      'May 4, 11:31 AM',
      'next message body',
    ].join('\n');

    const messages = parseIncomeTraderChat(text);
    expect(messages).toHaveLength(2);
    expect(messages[0].author).toBe('Tim Bohen');
    expect(messages[0].body).toContain('Daily Market Profits Alert');
    // The first message body MUST NOT contain the next author's name.
    expect(messages[0].body).not.toContain('planetdarr');
    expect(messages[1].author).toBe('planetdarr');
  });

  it('does not pull right-rail rows in as chat messages', () => {
    const text = [
      'henrySpps',
      'May 4, 11:14 AM',
      'normal chat',
      "Today's Tickers",
      'MODERATOR PICKS',
      '1',
      '$PN',
      '1',
      '+5%',
      '$6.01',
    ].join('\n');
    const messages = parseIncomeTraderChat(text);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe('normal chat');
  });
});
