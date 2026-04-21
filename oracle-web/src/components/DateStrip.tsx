interface DateStripProps {
  days: string[];
  selected: string;
  today: string;
  onSelect: (date: string) => void;
}

function weekdayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { weekday: 'short' });
}

function monthDayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? date
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function DateStrip({ days, selected, today, onSelect }: DateStripProps) {
  if (days.length === 0) return null;
  return (
    <div className="bg-white rounded-lg shadow p-2 flex items-center gap-1 overflow-x-auto">
      {days.map((date) => {
        const isSelected = date === selected;
        const isToday = date === today;
        return (
          <button
            key={date}
            onClick={() => onSelect(date)}
            className={`shrink-0 px-3 py-1.5 rounded text-xs flex flex-col items-center min-w-[64px] transition ${
              isSelected
                ? 'bg-gray-900 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <span className="uppercase tracking-wide text-[10px] opacity-80">
              {isToday ? 'Today' : weekdayLabel(date)}
            </span>
            <span className="font-semibold tabular-nums">{monthDayLabel(date)}</span>
          </button>
        );
      })}
    </div>
  );
}
