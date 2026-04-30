interface ZoneBarProps {
  stop: number | null;
  buy: number | null;
  sell: number | null;
  current: number | null;
  entry?: number | null;  // If traded, overlay actual entry
}

/**
 * Horizontal bar showing price position relative to stop / buy zone / sell zone.
 * Scale spans from a bit below stop to a bit above sell so markers stay inside.
 *
 * Buy zone is optional — when the Oracle tool doesn't publish one (sometimes
 * "$-" comes through for the whole watchlist), we still render the bar with
 * stop/sell/current so the user keeps the visual context. The blue Buy line
 * just doesn't draw.
 */
export function ZoneBar({ stop, buy, sell, current, entry }: ZoneBarProps) {
  if (stop === null || sell === null || current === null) {
    return <div className="text-xs text-gray-400">—</div>;
  }
  if (!(stop < sell)) {
    return <div className="text-xs text-gray-400">bad zone</div>;
  }
  // Buy must sit between stop and sell when present; otherwise treat it as missing.
  const buyOk = buy !== null && stop < buy && buy < sell;

  const span = sell - stop;
  const pad = span * 0.15;
  const min = stop - pad;
  const max = sell + pad;
  const range = max - min;

  const pct = (v: number) => Math.max(0, Math.min(100, ((v - min) / range) * 100));

  const stopPct = pct(stop);
  const buyPct = buyOk ? pct(buy as number) : null;
  const sellPct = pct(sell);
  const currentPct = pct(current);
  const entryPct = entry !== null && entry !== undefined ? pct(entry) : null;

  return (
    <div className="relative h-5 w-full min-w-[180px]">
      {/* Background track */}
      <div className="absolute inset-0 bg-gray-100 rounded" />

      {/* Dead zone (below stop): red tint */}
      <div
        className="absolute top-0 bottom-0 bg-red-100 rounded-l"
        style={{ left: 0, width: `${stopPct}%` }}
      />

      {/* Buy zone gradient (between buy and sell): green tint. When buy is
          missing we tint the whole stop→sell span instead so the eye still
          gets a "trade-able zone" cue. */}
      <div
        className="absolute top-0 bottom-0 bg-green-100"
        style={{
          left: `${buyPct ?? stopPct}%`,
          width: `${sellPct - (buyPct ?? stopPct)}%`,
        }}
      />

      {/* Blown out (above sell): purple tint */}
      <div
        className="absolute top-0 bottom-0 bg-purple-100 rounded-r"
        style={{ left: `${sellPct}%`, width: `${100 - sellPct}%` }}
      />

      {/* Stop line */}
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-red-600"
        style={{ left: `${stopPct}%` }}
        title={`Stop $${stop.toFixed(3)}`}
      />

      {/* Buy zone line — only when the Oracle tool published a real value. */}
      {buyPct !== null && buy !== null && (
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-blue-600"
          style={{ left: `${buyPct}%` }}
          title={`Buy Zone $${buy.toFixed(3)}`}
        />
      )}

      {/* Sell zone line */}
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-green-600"
        style={{ left: `${sellPct}%` }}
        title={`Sell Zone $${sell.toFixed(3)}`}
      />

      {/* Entry marker (if traded) */}
      {entryPct !== null && (
        <div
          className="absolute top-1 bottom-1 w-1 bg-orange-500 rounded"
          style={{ left: `calc(${entryPct}% - 2px)` }}
          title={`Entry $${entry!.toFixed(3)}`}
        />
      )}

      {/* Current price marker */}
      <div
        className="absolute top-0 bottom-0 w-1 bg-gray-900 rounded"
        style={{ left: `calc(${currentPct}% - 2px)` }}
        title={`Current $${current.toFixed(3)}`}
      />
    </div>
  );
}
