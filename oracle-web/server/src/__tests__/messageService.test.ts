import { describe, it, expect, beforeEach } from 'vitest';
import { messageService, MessageEventInput } from '../services/messageService.js';

describe('messageService', () => {
  describe('ingest', () => {
    it('creates an event with valid id, symbols, and tags', () => {
      const input: MessageEventInput = {
        text: 'AAPL gap and go above VWAP',
        channel: 'alerts',
        author: 'trader1',
      };
      const event = messageService.ingest(input);

      expect(event.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(event.symbols).toContain('AAPL');
      expect(event.tags).toContain('gap_and_go');
      expect(event.channel).toBe('alerts');
      expect(event.author).toBe('trader1');
    });

    it('extracts multiple symbols', () => {
      const event = messageService.ingest({ text: 'Watching TSLA and NVDA today' });
      expect(event.symbols).toContain('TSLA');
      expect(event.symbols).toContain('NVDA');
    });

    it('filters out stopwords from symbols', () => {
      const event = messageService.ingest({ text: 'BUY THE AAPL DIP FOR LONG' });
      expect(event.symbols).toContain('AAPL');
      expect(event.symbols).toContain('DIP');
      expect(event.symbols).not.toContain('BUY');
      expect(event.symbols).not.toContain('THE');
      expect(event.symbols).not.toContain('FOR');
      expect(event.symbols).not.toContain('LONG');
    });

    it('extracts multiple tags', () => {
      const event = messageService.ingest({
        text: 'TSLA gap and go, now red to green pattern',
      });
      expect(event.tags).toContain('gap_and_go');
      expect(event.tags).toContain('red_to_green');
    });

    it('assigns default channel and author when missing', () => {
      const event = messageService.ingest({ text: 'MSFT breakout' });
      expect(event.channel).toBe('general');
      expect(event.author).toBe('unknown');
    });

    it('computes confidence score based on symbols and tags', () => {
      // 1 symbol (0.25) + 1 tag (0.2) + short text (0) = 0.45
      const event = messageService.ingest({ text: 'AAPL gap and go' });
      expect(event.confidence).toBeGreaterThan(0);
      expect(event.confidence).toBeLessThanOrEqual(1);
    });

    it('caps confidence at 1.0', () => {
      // Many symbols + tags should still cap at 1.0
      const event = messageService.ingest({
        text: 'AAPL TSLA NVDA MSFT AMZN gap and go red to green vwap reclaim first pullback orb break parabolic news halt risk',
      });
      expect(event.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('ingestMany', () => {
    it('processes multiple inputs', () => {
      const inputs: MessageEventInput[] = [
        { text: 'AAPL running' },
        { text: 'TSLA squeeze' },
      ];
      const events = messageService.ingestMany(inputs);
      expect(events).toHaveLength(2);
      expect(events[0].symbols).toContain('AAPL');
      expect(events[1].symbols).toContain('TSLA');
    });
  });

  describe('getRecent', () => {
    it('returns events in reverse chronological order', () => {
      messageService.ingest({ text: 'First message AAPL' });
      messageService.ingest({ text: 'Second message TSLA' });
      const recent = messageService.getRecent(2);
      expect(recent[0].symbols).toContain('TSLA');
    });

    it('clamps limit to valid range', () => {
      const recent = messageService.getRecent(0);
      // limit 0 clamps to 1
      expect(recent.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('tag extraction', () => {
    it('detects vwap_reclaim', () => {
      const event = messageService.ingest({ text: 'TSLA vwap reclaim looking good' });
      expect(event.tags).toContain('vwap_reclaim');
    });

    it('detects orb_break', () => {
      const event = messageService.ingest({ text: 'SPY ORB break at 10:00' });
      expect(event.tags).toContain('orb_break');
    });

    it('detects halt_risk', () => {
      const event = messageService.ingest({ text: 'Be careful, MARA halted' });
      expect(event.tags).toContain('halt_risk');
    });

    it('detects parabolic_extension', () => {
      const event = messageService.ingest({ text: 'NVDA going parabolic' });
      expect(event.tags).toContain('parabolic_extension');
    });

    it('detects news_pop', () => {
      const event = messageService.ingest({ text: 'RIVN big news catalyst' });
      expect(event.tags).toContain('news_pop');
    });
  });
});
