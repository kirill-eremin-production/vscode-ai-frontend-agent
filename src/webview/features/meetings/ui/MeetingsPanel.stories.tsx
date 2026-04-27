import type { Meta, StoryObj } from '@storybook/react-vite';
import type { SessionSummary, UsageAggregate } from '@shared/runs/types';
import { MeetingCard } from './MeetingCard';

/**
 * Сторис журнала встреч (#0046).
 *
 * Полноценный `MeetingsPanel` завязан на общий store (collapsed-state,
 * выбранный ран, drill-in, live-now-таймер). В сторис собираем
 * представительный набор `MeetingCard`'ов — картинку «как выглядит
 * лента» — без прокидывания store mocks. AC #0046 требует двух
 * сценариев: пустой ран и ран с 5 сессиями включая активную и
 * paused-заглушку.
 *
 * Один `now` фиксируется в `Date('2026-04-26T12:00:00Z').getTime()`,
 * чтобы относительные метки `Nm ago` не мерцали при перезагрузке
 * Storybook (иначе каждый рендер брал бы `Date.now()` и таймштампы
 * сдвигались).
 */
const meta: Meta = {
  title: 'Features/Meetings/Panel',
};
export default meta;
type Story = StoryObj;

const ZERO_USAGE: UsageAggregate = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  lastTotalTokens: 0,
  lastModel: null,
};

const NOW = new Date('2026-04-26T12:00:00Z').getTime();

function session(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    kind: 'user-agent',
    status: 'running',
    createdAt: '2026-04-26T10:00:00Z',
    updatedAt: '2026-04-26T10:00:00Z',
    usage: ZERO_USAGE,
    inputFrom: 'user',
    prev: [],
    next: [],
    participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
    ...over,
  };
}

const FIVE_SESSIONS: SessionSummary[] = [
  // 1. Корневая встреча: пользователь и продакт. Активная.
  session({
    id: 's1',
    createdAt: '2026-04-26T10:00:00Z',
    status: 'awaiting_user_input',
    participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
    inputFrom: 'user',
  }),
  // 2. Bridge product → architect.
  session({
    id: 's2',
    kind: 'agent-agent',
    createdAt: '2026-04-26T10:30:00Z',
    status: 'done',
    participants: [
      { kind: 'agent', role: 'product' },
      { kind: 'agent', role: 'architect' },
    ],
    inputFrom: 'product',
    prev: ['s1'],
    next: ['s3'],
  }),
  // 3. Bridge architect → programmer.
  session({
    id: 's3',
    kind: 'agent-agent',
    createdAt: '2026-04-26T11:00:00Z',
    status: 'done',
    participants: [
      { kind: 'agent', role: 'architect' },
      { kind: 'agent', role: 'programmer' },
    ],
    inputFrom: 'architect',
    prev: ['s2'],
    next: ['s4'],
  }),
  // 4. Multi-room: программист зовёт продакта, архитектор — обязательный
  // промежуточный (см. US-31). 3 участника, активная.
  session({
    id: 's4',
    kind: 'agent-agent',
    createdAt: '2026-04-26T11:30:00Z',
    status: 'running',
    participants: [
      { kind: 'agent', role: 'programmer' },
      { kind: 'agent', role: 'architect' },
      { kind: 'agent', role: 'product' },
    ],
    inputFrom: 'programmer',
    prev: ['s3'],
    next: [],
  }),
  // 5. Paused-заглушка: статус сессии не paused (его пока нет в типе),
  // но ран ушёл в `awaiting_human` — на канвасе и в журнале такая
  // сессия трактуется как «нерабочая, ждёт». В #0052 здесь появится
  // реальный paused-визуал.
  session({
    id: 's5',
    createdAt: '2026-04-26T11:50:00Z',
    status: 'awaiting_human',
    participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
    inputFrom: 'user',
  }),
];

/**
 * Пустой ран — ни одной сессии. Карточек нет, панель показывает
 * fallback-подпись «У этого рана пока нет встреч.». Внутри сторис
 * имитируем body-часть, без шасси.
 */
export const EmptyRun: Story = {
  render: () => (
    <Frame title="Пустой ран — без сессий">
      <p className="text-[11px] text-muted m-0">У этого рана пока нет встреч.</p>
    </Frame>
  ),
};

/**
 * Ран с 5 сессиями — основная сторис под AC #0046. Карточки
 * отсортированы свежие сверху; активная — `s1`; multi-room — `s4`;
 * `s5` — paused-заглушка.
 */
export const FiveSessions: Story = {
  render: () => (
    <Frame title="Ран с 5 сессиями (включая активную и paused-заглушку)">
      <ul className="list-none m-0 p-0 flex flex-col gap-1">
        {[...FIVE_SESSIONS]
          .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
          .map((session, index) => (
            <li key={session.id}>
              <MeetingCard
                session={session}
                index={FIVE_SESSIONS.length - 1 - index}
                isActive={session.id === 's4'}
                isLive={session.status === 'running' || session.status === 'awaiting_user_input'}
                now={NOW}
                preview={
                  session.id === 's4'
                    ? 'Программист: можно обсудить кейс с продактом, нужен общий ответ.'
                    : undefined
                }
                onSelect={() => {
                  /* no-op в сторис: drill-in идёт через store */
                }}
              />
            </li>
          ))}
      </ul>
    </Frame>
  ),
};

/**
 * Обёртка-«панель»: фон, рамка, ширина ≈240px (как реальная
 * правая колонка). Tab-strip и collapse-кнопку не дублируем —
 * сторис сосредоточена на содержимом ленты.
 */
function Frame(props: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        width: 280,
        border: '1px solid var(--vscode-input-border, #444)',
        borderRadius: 4,
        padding: 8,
        background: 'var(--vscode-sideBar-background, #1e1e1e)',
      }}
    >
      <div style={{ fontSize: 11, marginBottom: 8, color: 'var(--vscode-descriptionForeground)' }}>
        {props.title}
      </div>
      {props.children}
    </div>
  );
}
