import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ChatMessage, RunMeta, SessionSummary, UsageAggregate } from '@shared/runs/types';
import { RunCanvas } from './RunCanvas';

/**
 * Сторис канваса под состояния кубиков (#0044).
 *
 * Без store/IPC: meta + chat собираются вручную, чтобы каждое из трёх
 * состояний (idle/working/awaiting_user) показалось одновременно.
 * Конкретно — три кубика на одном канвасе:
 *  - product — `awaiting_user` (последнее сообщение от продакта,
 *    ран в `awaiting_user_input`);
 *  - architect — `working` (последнее сообщение в bridge-сессии от
 *    product'а, кубик архитектора пульсирует);
 *  - programmer — `idle` (не участник активной сессии, просто стоит).
 *
 * Активная сессия в этом сценарии — bridge product↔architect. На неё
 * приходится chat и cube-state для architect'а. product получает
 * awaiting_user из «своей» (предыдущей) сессии — но cube-state
 * считается по активной, так что для одной демонстрации трёх состояний
 * пришлось разнести их по разным историям. Ниже два story-варианта:
 * один общий «галерея состояний» с тремя инстансами канваса, и второй —
 * один канвас с одной active-сессией для проверки реального layout'а.
 */
const meta: Meta = {
  title: 'Features/Canvas/Cube states',
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

function session(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    kind: 'user-agent',
    status: 'running',
    createdAt: '2026-04-26T10:00:00Z',
    updatedAt: '2026-04-26T10:00:00Z',
    usage: ZERO_USAGE,
    ...over,
  };
}

function buildRunMeta(over: Partial<RunMeta> & { sessions: SessionSummary[] }): RunMeta {
  return {
    id: 'r1',
    title: 'Демо состояний кубиков',
    prompt: 'Разные состояния canvas',
    status: 'running',
    createdAt: '2026-04-26T10:00:00Z',
    updatedAt: '2026-04-26T10:00:00Z',
    activeSessionId: over.sessions[0]?.id ?? 's1',
    usage: ZERO_USAGE,
    ...over,
  };
}

function chatMessage(id: string, from: string, text = '...'): ChatMessage {
  return { id, from, at: '2026-04-26T10:00:00Z', text };
}

// Канвас в idle-состоянии: все три роли присутствуют, но активной
// сессии нет ни одной (selectActiveSessionForRole вернёт fallback'и).
// Используется как «фон» для сравнения с активными состояниями.
const idleMeta = buildRunMeta({
  sessions: [
    session({
      id: 's1',
      status: 'done',
      participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
    }),
    session({
      id: 's2',
      kind: 'agent-agent',
      status: 'done',
      participants: [
        { kind: 'agent', role: 'product' },
        { kind: 'agent', role: 'architect' },
      ],
    }),
    session({
      id: 's3',
      kind: 'agent-agent',
      status: 'done',
      participants: [
        { kind: 'agent', role: 'architect' },
        { kind: 'agent', role: 'programmer' },
      ],
    }),
  ],
  activeSessionId: 's1',
  status: 'done',
});

// Канвас в working-состоянии: bridge product↔architect, последнее
// сообщение от продакта — кубик архитектора должен пульсировать.
const workingMeta = buildRunMeta({
  sessions: [
    session({
      id: 's1',
      status: 'done',
      participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
    }),
    session({
      id: 's2',
      kind: 'agent-agent',
      status: 'running',
      participants: [
        { kind: 'agent', role: 'product' },
        { kind: 'agent', role: 'architect' },
      ],
    }),
  ],
  activeSessionId: 's2',
  status: 'running',
});

const workingChat: ChatMessage[] = [chatMessage('m1', 'agent:product', 'Архитектор, оцени план.')];

// Канвас в awaiting_user-состоянии: product задал вопрос пользователю,
// статус рана `awaiting_user_input`. На канвасе кубик продакта горит
// жёлтым «требуется ответ пользователя».
const awaitingMeta = buildRunMeta({
  sessions: [
    session({
      id: 's1',
      status: 'awaiting_user_input',
      participants: [{ kind: 'user' }, { kind: 'agent', role: 'product' }],
    }),
  ],
  activeSessionId: 's1',
  status: 'awaiting_user_input',
});

const awaitingChat: ChatMessage[] = [
  chatMessage('m1', 'user', 'Сделай тёмную тему.'),
  chatMessage('m2', 'agent:product', 'Уточни: где сохранять выбор — localStorage или профиль?'),
];

/**
 * Галерея трёх состояний рядом — основная сторис под AC #0044
 * («канвас с тремя кубиками в разных состояниях»). Размещаем три
 * независимых канваса в grid'е, потому что на одной meta все три
 * состояния одновременно встретиться не могут (active-сессия одна).
 */
export const ThreeCubeStates: Story = {
  render: () => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(280px, 1fr))',
        gap: 16,
        height: 640,
      }}
    >
      <Frame title="idle">
        <RunCanvas meta={idleMeta} tools={[]} chat={[]} />
      </Frame>
      <Frame title="working (architect отвечает product'у)">
        <RunCanvas meta={workingMeta} tools={[]} chat={workingChat} />
      </Frame>
      <Frame title="awaiting_user (product ждёт ответа)">
        <RunCanvas meta={awaitingMeta} tools={[]} chat={awaitingChat} />
      </Frame>
    </div>
  ),
};

function Frame(props: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        border: '1px solid var(--vscode-input-border, #444)',
        borderRadius: 4,
        padding: 8,
        height: '100%',
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>
        {props.title}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{props.children}</div>
    </div>
  );
}
