import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ChatMessage as ChatMessageData, Participant } from '@shared/runs/types';
import { ChatMessage } from './ChatMessage';
import { ParticipantsHeader } from './ParticipantsHeader';
import { ParticipantJoinedRow } from './ParticipantJoinedRow';

/**
 * Сторис чата на N участников (#0041): шапка с аватарами, ленты bubble'ов
 * с ролевыми маркерами и системная строка `participant_joined` посередине.
 *
 * Без store/IPC: все данные — статические литералы. Сценарий описывает
 * визуальный кейс, на который опирается AC задачи (3 участника + событие
 * входа третьего).
 */
const meta: Meta = {
  title: 'Features/Chat/Multi-participant',
};
export default meta;

type Story = StoryObj;

const PARTICIPANTS_BEFORE: Participant[] = [{ kind: 'user' }, { kind: 'agent', role: 'product' }];

const PARTICIPANTS_AFTER: Participant[] = [
  { kind: 'user' },
  { kind: 'agent', role: 'product' },
  { kind: 'agent', role: 'architect' },
];

const PARTICIPANTS_FULL_ROOM: Participant[] = [
  { kind: 'user' },
  { kind: 'agent', role: 'product' },
  { kind: 'agent', role: 'architect' },
  { kind: 'agent', role: 'programmer' },
];

function chat(id: string, from: string, at: string, text: string): ChatMessageData {
  return { id, from, at, text };
}

export const ThreeParticipantsWithJoinEvent: Story = {
  render: () => {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          maxWidth: 480,
          gap: 8,
          padding: 12,
        }}
      >
        <ParticipantsHeader participants={PARTICIPANTS_AFTER} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <ChatMessage
            message={chat('m1', 'user', '2026-04-26T10:00:00Z', 'Хочу добавить onboarding-flow.')}
          />
          <ChatMessage
            message={chat(
              'm2',
              'agent:product',
              '2026-04-26T10:01:00Z',
              'Окей, уточняющий вопрос: целевая аудитория — новые юзеры или вернувшиеся?'
            )}
          />
          <ChatMessage
            message={chat(
              'm3',
              'user',
              '2026-04-26T10:02:00Z',
              'Только новые, пара-тройка экранов.'
            )}
          />
          <ParticipantJoinedRow role="architect" at="2026-04-26T10:03:00Z" />
          <ChatMessage
            message={chat(
              'm4',
              'agent:architect',
              '2026-04-26T10:03:30Z',
              'Подключился. Вижу контекст: предлагаю **react-router** + локальный state, без выделенной фичи.'
            )}
          />
          <ChatMessage
            message={chat(
              'm5',
              'agent:product',
              '2026-04-26T10:04:00Z',
              'Принято. Программисту — реализуй три экрана с шагами 1/2/3.'
            )}
          />
        </div>
      </div>
    );
  },
};

export const FullTeamRoom: Story = {
  render: () => (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        maxWidth: 480,
        gap: 8,
        padding: 12,
      }}
    >
      <ParticipantsHeader participants={PARTICIPANTS_FULL_ROOM} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <ChatMessage
          message={chat(
            'p1',
            'agent:programmer',
            '2026-04-26T11:00:00Z',
            'Команда, готов поднять три экрана. Один уточняющий: сторадж — `localStorage` ок?'
          )}
        />
        <ParticipantJoinedRow role="product" at="2026-04-26T11:00:30Z" />
        <ChatMessage
          message={chat(
            'p2',
            'agent:product',
            '2026-04-26T11:01:00Z',
            'Да, для MVP `localStorage` достаточно — позже мигрируем.'
          )}
        />
      </div>
    </div>
  ),
};

export const PreJoinHeaderOnly: Story = {
  render: () => (
    <div style={{ maxWidth: 480, padding: 12 }}>
      <ParticipantsHeader participants={PARTICIPANTS_BEFORE} />
    </div>
  ),
};
