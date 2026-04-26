/**
 * Относительное форматирование timestamp'а ISO-строки для шапок чат-сообщений
 * (#0020). Без `date-fns`/`dayjs` — на длинной дистанции, если понадобится
 * больше работы с датами, заведём библиотеку отдельно.
 *
 * Возвращает:
 *  - `label` — короткая человекочитаемая фраза для отображения;
 *  - `tooltip` — полная локальная дата+время, чтобы навести курсор и увидеть точное.
 */
export interface RelativeTime {
  label: string;
  tooltip: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const MONTHS_RU = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
];

export function formatRelativeTime(at: string, now: Date = new Date()): RelativeTime {
  const date = new Date(at);
  const tooltip = formatTooltip(date);
  const diff = now.getTime() - date.getTime();

  if (Number.isNaN(date.getTime())) return { label: at, tooltip: at };

  if (diff < MINUTE) return { label: 'только что', tooltip };
  if (diff < HOUR) {
    const minutes = Math.floor(diff / MINUTE);
    return { label: `${minutes} ${pluralMinutes(minutes)} назад`, tooltip };
  }
  if (isSameDay(date, now)) {
    return { label: `сегодня в ${formatHm(date)}`, tooltip };
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) {
    return { label: `вчера в ${formatHm(date)}`, tooltip };
  }
  if (date.getFullYear() === now.getFullYear()) {
    return { label: `${date.getDate()} ${MONTHS_RU[date.getMonth()]}`, tooltip };
  }
  return {
    label: `${date.getDate()} ${MONTHS_RU[date.getMonth()]} ${date.getFullYear()}`,
    tooltip,
  };
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatHm(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function pluralMinutes(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'минуту';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'минуты';
  return 'минут';
}

function formatTooltip(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
