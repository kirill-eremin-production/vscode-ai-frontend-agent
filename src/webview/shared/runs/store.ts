import { useEffect, useSyncExternalStore } from 'react';
import { vscode } from '@shared/api/vscode';
import type { ChatMessage, RunMeta } from './types';

/**
 * Простой in-memory store ранов для webview.
 *
 * Намеренно НЕ используем Redux/Zustand: первая итерация — один список
 * и один выбранный ран. Зависеть здесь от стороннего state-менеджера
 * было бы преждевременно.
 *
 * Реализация — классический паттерн «subscribe + getSnapshot» поверх
 * `useSyncExternalStore`: гарантирует, что несколько компонентов из
 * разных фич видят одно и то же состояние без провайдера в дереве.
 *
 * Содержимое состояния:
 *  - `runs` — список метаданных всех ранов (отрисовывает run-list);
 *  - `selectedId` — id текущего открытого рана;
 *  - `selectedDetails` — meta + chat выбранного, если уже подгружены.
 */

interface RunsState {
  runs: RunMeta[];
  selectedId: string | undefined;
  selectedDetails: { meta: RunMeta; chat: ChatMessage[] } | undefined;
}

const initialState: RunsState = {
  runs: [],
  selectedId: undefined,
  selectedDetails: undefined,
};

/**
 * Текущее состояние и подписчики живут в модуле как обычные переменные.
 * Это безопасно, потому что webview-бандл монтируется один раз за
 * жизнь страницы, а HMR здесь не используется.
 */
let state: RunsState = initialState;
const listeners = new Set<() => void>();

/** Подписаться на любые изменения состояния. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Прочитать текущий снапшот; стабильная ссылка важна для useSyncExternalStore. */
function getSnapshot(): RunsState {
  return state;
}

/** Атомарно обновить state и оповестить подписчиков. */
function setState(updater: (prev: RunsState) => RunsState): void {
  state = updater(state);
  listeners.forEach((l) => l());
}

/* ── Команды (отправка сообщений в extension host) ──────────────── */

/**
 * Сообщения, которые отправляет webview. Дублируют contract из
 * extension по тем же причинам, что и типы (см. `types.ts`).
 */
type WebviewToExtensionMessage =
  | { type: 'runs.create'; prompt: string }
  | { type: 'runs.list' }
  | { type: 'runs.get'; id: string }
  | { type: 'runs.setApiKey' };

function send(msg: WebviewToExtensionMessage): void {
  vscode.postMessage(msg);
}

/** Запросить актуальный список ранов у extension. */
export function requestRunsList(): void {
  send({ type: 'runs.list' });
}

/** Создать новый ран по тексту запроса пользователя. */
export function createRun(prompt: string): void {
  send({ type: 'runs.create', prompt });
}

/** Открыть input box для ввода/обновления ключа OpenRouter. */
export function setApiKey(): void {
  send({ type: 'runs.setApiKey' });
}

/** Запросить детали конкретного рана и отметить его как выбранный. */
export function selectRun(id: string): void {
  // Сначала обновляем выбор локально — UI реагирует мгновенно,
  // даже до прихода `runs.get.result`.
  setState((prev) => ({ ...prev, selectedId: id, selectedDetails: undefined }));
  send({ type: 'runs.get', id });
}

/* ── Приём сообщений из extension ───────────────────────────────── */

/**
 * Сообщения, которые приходят от extension. Парсим без runtime-валидации:
 * на этапе разработки нам важнее видеть рассинхрон контрактов в TS,
 * чем тратить байты на zod/io-ts. Если контракт разъедется, мы это
 * увидим в первой же ошибке рендера.
 */
type ExtensionToWebviewMessage =
  | { type: 'runs.list.result'; runs: RunMeta[] }
  | { type: 'runs.get.result'; id: string; meta?: RunMeta; chat?: ChatMessage[] }
  | { type: 'runs.created'; meta: RunMeta }
  | { type: 'runs.error'; message: string };

/**
 * Хук-подписчик, который должен быть установлен ровно один раз на
 * корневом компоненте. Вешает обработчик `message` на window и
 * раскладывает входящие события в state.
 *
 * Почему отдельный хук, а не auto-init на уровне модуля: window-listener
 * легко завести при старте бандла, но тогда его нельзя снять при
 * unmount-е (в HMR/тестах это даёт утечки). С хуком жизненный цикл
 * подписки совпадает с жизненным циклом приложения.
 */
export function useRunsWiring(): void {
  useEffect(() => {
    const onMessage = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const data = event.data;
      // Чужие/посторонние сообщения здесь просто игнорируем —
      // фильтрация по `data.type` ниже сама их отбрасывает.
      if (typeof data !== 'object' || data === null) return;

      switch (data.type) {
        case 'runs.list.result': {
          setState((prev) => ({ ...prev, runs: data.runs }));
          return;
        }
        case 'runs.created': {
          // Добавляем новый ран в начало списка и сразу выбираем.
          // Бэкенд после `created` всё равно пришлёт `list.result`,
          // но локальное обновление избавляет от мерцания UI.
          setState((prev) => ({
            ...prev,
            runs: [data.meta, ...prev.runs.filter((r) => r.id !== data.meta.id)],
            selectedId: data.meta.id,
            selectedDetails: { meta: data.meta, chat: [] },
          }));
          return;
        }
        case 'runs.get.result': {
          // Принимаем только если ответ соответствует текущему выбору —
          // иначе старый медленный ответ перетрёт свежий выбор пользователя.
          setState((prev) => {
            if (prev.selectedId !== data.id) return prev;
            if (!data.meta) {
              return { ...prev, selectedDetails: undefined };
            }
            return {
              ...prev,
              selectedDetails: { meta: data.meta, chat: data.chat ?? [] },
            };
          });
          return;
        }
        case 'runs.error': {
          // Ошибки уже показывает extension через showErrorMessage.
          // Здесь только логируем в консоль webview для отладки.
          console.error('[runs]', data.message);
          return;
        }
        default:
          return;
      }
    };

    window.addEventListener('message', onMessage);

    // При первом монтировании сразу запрашиваем актуальный список —
    // иначе при открытии webview пользователь увидит пустой экран.
    requestRunsList();

    return () => window.removeEventListener('message', onMessage);
  }, []);
}

/** Хук-чтение всего state. Возвращает стабильный снапшот. */
export function useRunsState(): RunsState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
