import { useEffect, useSyncExternalStore } from 'react';
import { vscode } from '@shared/api/vscode';
import type { ChatMessage, PendingAsk, RunMeta, ToolEvent } from './types';

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
 *  - `selectedDetails` — meta + chat + tools выбранного, если уже подгружены;
 *  - `pendingAsk` — текущий вопрос от агента к пользователю по выбранному
 *    рану (если ран в `awaiting_user_input`);
 *  - `pendingByRun` — кэш «ран → актуальный pendingAsk» для подсветки
 *    в списке. Заполняется при `runs.askUser` broadcast'ах;
 *  - `selectedBrief` — содержимое `brief.md` выбранного, если есть.
 *  - `selectedPlan` — содержимое `plan.md` выбранного (артефакт
 *    архитектора, #0004), если есть.
 */

interface RunsState {
  runs: RunMeta[];
  selectedId: string | undefined;
  /**
   * Какую сессию рана сейчас просматривает пользователь. Undefined =
   * «активная сессия из RunMeta» (дефолт при выборе рана). Меняется
   * кликом по табу сессии в RunDetails. Если выбранная сессия совпала
   * с `meta.activeSessionId` — composer и live-апдейты работают как
   * раньше; если выбрали другую — карточка в read-only режиме (#0012).
   */
  selectedSessionId: string | undefined;
  selectedDetails: { meta: RunMeta; chat: ChatMessage[]; tools: ToolEvent[] } | undefined;
  pendingAsk: PendingAsk | undefined;
  pendingByRun: Record<string, PendingAsk>;
  /**
   * Содержимое `brief.md` выбранного рана, если оно уже на диске.
   * Заполняется при `runs.get.result`. Хранится отдельно от
   * `selectedDetails`, потому что бриф иногда обновляется без
   * перезагрузки чата (например, продакт допишет уточнения после
   * approve — тогда extension пришлёт фокус-обновление; на этой
   * итерации такого пути нет, но место под него зарезервировано).
   */
  selectedBrief: string | undefined;
  /**
   * Содержимое `plan.md` выбранного рана. Заполняется в `runs.get.result`
   * по той же схеме, что и `selectedBrief` (см. issue #0004).
   */
  selectedPlan: string | undefined;
  /**
   * Свёрнут ли левый сайдбар (RunListPanel). Persist'ится через UI-префы
   * (#0017) — состояние переживает перезапуск VS Code. На узком окне
   * (< 700px) при первом старте инициализируется в true (см. useRunsWiring).
   */
  leftPanelCollapsed: boolean;
  /**
   * Per-run явный выбор пользователя: свёрнута ли правая панель сессий
   * (#0019). Если ключа нет — collapsed-state выводится из количества
   * сессий рана через {@link selectSessionsPanelCollapsed} (одна сессия
   * → свёрнуто, больше → развёрнуто). Persist'ится через UI-префы под
   * ключом `sessionsPanel.collapsed.<runId>`, чтобы выбор пережил
   * перезапуск VS Code.
   */
  sessionsPanelCollapsedByRun: Record<string, boolean>;
  /**
   * Режим main-area: 'run-details' — карточка выбранного рана,
   * 'new-run' — форма создания нового рана (#0018), 'empty' — приглашение
   * «запустите команду агентов». Контракт с #0017: переключается через
   * `startNewRun()` / `cancelNewRun()` / `selectRun()` (последний
   * автоматически возвращает в 'run-details').
   */
  mainAreaMode: MainAreaMode;
  /**
   * IPC по созданию рана идёт асинхронно: между `runs.create` и
   * `runs.created`/`runs.error`/`runs.create.aborted` форма должна
   * показывать loading-состояние и блокировать повторный сабмит.
   * Глобально, потому что форма одна, а её состояние тут устойчиво
   * к ремаунтам.
   */
  createRunPending: boolean;
  /**
   * Сообщение последней ошибки `runs.create`. Форма показывает его под
   * кнопкой и предлагает «Повторить». Сбрасывается при повторном сабмите,
   * успешном создании, отмене формы и `clearCreateRunError()`.
   */
  createRunError: string | undefined;
  /**
   * Открыт ли в VS Code workspace (US-5). Без него `runs.create` сразу
   * упадёт на `getWorkspaceRoot`, поэтому UI превентивно блокирует
   * «+ Новый ран» с tooltip'ом «Откройте папку проекта». По умолчанию
   * считаем true — иначе при холодном старте кнопка мигнёт disabled →
   * enabled, пока не придёт ответ.
   */
  hasWorkspace: boolean;
}

export type MainAreaMode = 'run-details' | 'new-run' | 'empty';

const initialState: RunsState = {
  runs: [],
  selectedId: undefined,
  selectedSessionId: undefined,
  selectedDetails: undefined,
  pendingAsk: undefined,
  pendingByRun: {},
  selectedBrief: undefined,
  selectedPlan: undefined,
  leftPanelCollapsed: false,
  sessionsPanelCollapsedByRun: {},
  mainAreaMode: 'empty',
  createRunPending: false,
  createRunError: undefined,
  hasWorkspace: true,
};

/**
 * Ключи UI-префов в `globalState`. Держим централизованно, чтобы случайно
 * не разъехаться: store пишет `leftPanelCollapsed`, а extension читает
 * `leftCollapsed` — такая опечатка тут невозможна.
 */
const UI_PREF_KEYS = {
  leftPanelCollapsed: 'shell.leftPanelCollapsed',
} as const;

/**
 * Префикс для per-run UI-префов панели сессий (#0019). Конкретный ключ —
 * `sessionsPanel.collapsed.<runId>`. Префикс держим отдельной константой,
 * чтобы и writer (setSessionsPanelCollapsed), и reader (state.uiPrefs.result)
 * собирали одно и то же имя без опечаток.
 */
const SESSIONS_PANEL_PREF_PREFIX = 'sessionsPanel.collapsed.';

function sessionsPanelPrefKey(runId: string): string {
  return `${SESSIONS_PANEL_PREF_PREFIX}${runId}`;
}

/**
 * Порог узкого окна, ниже которого обе панели по умолчанию свёрнуты
 * (#0017 acceptance). Применяется только если в UI-префах ничего не
 * сохранено — т.е. при первом запуске; явный выбор пользователя всегда
 * перебивает порог.
 */
const NARROW_WINDOW_PX = 700;

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
  listeners.forEach((listener) => listener());
}

/* ── Команды (отправка сообщений в extension host) ──────────────── */

/**
 * Сообщения, которые отправляет webview. Дублируют contract из
 * extension по тем же причинам, что и типы (см. `types.ts`).
 */
type WebviewToExtensionMessage =
  | { type: 'runs.create'; prompt: string; title?: string }
  | { type: 'runs.list' }
  | { type: 'runs.get'; id: string; sessionId?: string }
  | { type: 'runs.setApiKey' }
  | { type: 'runs.user.message'; runId: string; text: string; finalize?: boolean }
  | { type: 'editor.open'; path: string }
  | { type: 'state.setUiPref'; key: string; value: unknown }
  | { type: 'state.getUiPrefs' }
  | { type: 'state.getWorkspace' };

function send(message: WebviewToExtensionMessage): void {
  vscode.postMessage(message);
}

/** Запросить актуальный список ранов у extension. */
export function requestRunsList(): void {
  send({ type: 'runs.list' });
}

/**
 * Создать новый ран по тексту запроса пользователя. Опциональный
 * `title` (US-2 / #0018): если пустой/undefined — extension сгенерит
 * заголовок моделью. Локально выставляем `createRunPending=true`,
 * чтобы форма мгновенно показала loading-состояние и заблокировала
 * повторный сабмит. Pending снимается на `runs.created`,
 * `runs.create.aborted` или `runs.error`.
 */
export function createRun(prompt: string, title?: string): void {
  setState((prev) => ({
    ...prev,
    createRunPending: true,
    createRunError: undefined,
  }));
  send({ type: 'runs.create', prompt, title });
}

/** Сбросить ошибку формы создания (например, при правке поля). */
export function clearCreateRunError(): void {
  setState((prev) =>
    prev.createRunError === undefined ? prev : { ...prev, createRunError: undefined }
  );
}

/** Открыть input box для ввода/обновления ключа OpenRouter. */
export function setApiKey(): void {
  send({ type: 'runs.setApiKey' });
}

/** Запросить детали конкретного рана и отметить его как выбранный. */
export function selectRun(id: string): void {
  // Сначала обновляем выбор локально — UI реагирует мгновенно,
  // даже до прихода `runs.get.result`.
  setState((prev) => ({
    ...prev,
    // Выбор рана всегда возвращает main-area в режим деталей —
    // даже если до этого пользователь открыл форму создания.
    mainAreaMode: 'run-details',
    selectedId: id,
    // selectedSessionId сбрасываем на undefined — это означает «активная
    // сессия по умолчанию». Конкретный id придёт в runs.get.result и
    // запишется туда.
    selectedSessionId: undefined,
    selectedDetails: undefined,
    // pendingAsk сразу подтягиваем из кэша, если уже знаем — снимет
    // мерцание «вопрос → нет вопроса → вопрос» при переключении.
    pendingAsk: prev.pendingByRun[id],
    // Бриф нового выбранного рана пока неизвестен — сбрасываем,
    // прилетит в `runs.get.result`. Иначе показывали бы бриф предыдущего.
    selectedBrief: undefined,
    selectedPlan: undefined,
  }));
  send({ type: 'runs.get', id });
}

/**
 * Переключиться на конкретную сессию выбранного рана. Используется при
 * клике по табу сессии в RunDetails (#0012). Локально сбрасываем chat/
 * tools, чтобы пользователь видел индикацию загрузки, а не остатки
 * предыдущей сессии; реальные данные придут в `runs.get.result`.
 *
 * Если sessionId совпал с текущим — ничего не делаем, экономим round-trip.
 */
export function selectSession(runId: string, sessionId: string): void {
  setState((prev) => {
    if (prev.selectedId !== runId) return prev;
    if (prev.selectedSessionId === sessionId) return prev;
    return {
      ...prev,
      selectedSessionId: sessionId,
      selectedDetails: prev.selectedDetails
        ? { ...prev.selectedDetails, chat: [], tools: [] }
        : prev.selectedDetails,
    };
  });
  send({ type: 'runs.get', id: runId, sessionId });
}

/**
 * Отправить сообщение пользователя в чат рана.
 *
 * Унифицированный канал: extension сам решает по статусу, что это
 * (см. wire.ts:handleUserMessage):
 *  - `awaiting_user_input` → ответ на pending ask_user;
 *  - `awaiting_human` / `failed` → продолжение диалога (US-10);
 *  - `running` / `draft` → отбрасывается с runs.error.
 *
 * Локально для `awaiting_user_input` сразу убираем `pendingAsk` —
 * UI закрывает форму вопроса, не дожидаясь подтверждения от extension.
 * Если что-то пойдёт не так, `runs.askUser` прилетит снова и форма
 * вернётся.
 */
export function sendUserMessage(runId: string, text: string): void {
  setState((prev) => {
    // Если для этого рана висит pending ask_user — оптимистично снимаем его
    // локально (UI закрывает баннер мгновенно). Для continue-режима
    // (awaiting_human/failed) pendingAsk и так нет — ничего не меняется.
    if (prev.pendingByRun[runId] === undefined) return prev;
    const nextByRun = { ...prev.pendingByRun };
    delete nextByRun[runId];
    return {
      ...prev,
      pendingAsk: prev.selectedId === runId ? undefined : prev.pendingAsk,
      pendingByRun: nextByRun,
    };
  });
  send({ type: 'runs.user.message', runId, text });
}

/**
 * Сигнал «достаточно вопросов, оформляй» (US-13). Шлётся вместо обычного
 * ответа на pending `ask_user` — extension сам подставит дословный
 * маркер для модели и короткий текст для chat.jsonl. Поле text здесь
 * пустое: кнопка одна, выбор пользователю не предлагается.
 */
export function sendFinalizeSignal(runId: string): void {
  setState((prev) => {
    if (prev.pendingByRun[runId] === undefined) return prev;
    const nextByRun = { ...prev.pendingByRun };
    delete nextByRun[runId];
    return {
      ...prev,
      pendingAsk: prev.selectedId === runId ? undefined : prev.pendingAsk,
      pendingByRun: nextByRun,
    };
  });
  send({ type: 'runs.user.message', runId, text: '', finalize: true });
}

/**
 * Перевести main-area в режим создания нового рана (#0017/#0018).
 * Сама форма пока заглушка — реальная реализация в #0018.
 *
 * Намеренно НЕ сбрасываем `selectedId`: вернувшись из формы (например,
 * кликом по рану в списке), пользователь должен видеть тот же выбор,
 * что и до перехода в new-run.
 */
export function startNewRun(): void {
  setState((prev) => ({
    ...prev,
    mainAreaMode: 'new-run',
    // Свежее открытие формы — без следов прошлых ошибок.
    createRunError: undefined,
  }));
}

/**
 * Закрыть форму создания (#0018). Если у пользователя есть выбранный
 * ран — возвращаемся в его детали; если нет — в empty state. Pending-
 * состояние сбрасывать НЕ нужно: если IPC ещё в полёте, ответ всё равно
 * прилетит — просто форма уже не показана. Но ошибку сбрасываем — она
 * привязана к закрытой сессии формы.
 */
export function cancelNewRun(): void {
  setState((prev) => ({
    ...prev,
    mainAreaMode: prev.selectedId ? 'run-details' : 'empty',
    createRunError: undefined,
  }));
}

/**
 * Сохранить значение UI-префа: локально применяет немедленно, потом
 * шлёт `state.setUiPref` в extension для persist'а в `globalState`.
 * Optimistic update оставляет UI отзывчивым — даже если extension
 * сейчас не отвечает (host перезапускается), визуально префы работают.
 */
export function setUiPref(key: string, value: unknown): void {
  if (key === UI_PREF_KEYS.leftPanelCollapsed && typeof value === 'boolean') {
    setState((prev) => ({ ...prev, leftPanelCollapsed: value }));
  }
  send({ type: 'state.setUiPref', key, value });
}

/** Удобные типизированные обёртки над `setUiPref` — используют UI-компоненты. */
export function setLeftPanelCollapsed(collapsed: boolean): void {
  setUiPref(UI_PREF_KEYS.leftPanelCollapsed, collapsed);
}

/**
 * Записать явный выбор пользователя для панели сессий конкретного рана
 * (#0019). Persist'ится отдельным ключом per-run, чтобы каждый ран помнил
 * собственное предпочтение независимо от соседей. До первого вызова
 * для рана collapsed-state выводится из количества сессий через
 * {@link selectSessionsPanelCollapsed}.
 */
export function setSessionsPanelCollapsed(runId: string, collapsed: boolean): void {
  setState((prev) => ({
    ...prev,
    sessionsPanelCollapsedByRun: {
      ...prev.sessionsPanelCollapsedByRun,
      [runId]: collapsed,
    },
  }));
  send({ type: 'state.setUiPref', key: sessionsPanelPrefKey(runId), value: collapsed });
}

/**
 * Эффективное «свёрнута ли правая панель» для текущего выбранного рана.
 * Контракт #0019:
 *  - явный выбор пользователя (`sessionsPanelCollapsedByRun[selectedId]`)
 *    всегда побеждает;
 *  - иначе fallback по количеству сессий: одна → свёрнуто, больше → нет;
 *  - без выбранного рана панель свёрнута (показывать там нечего).
 *
 * Вынесено отдельным селектором, чтобы и AppShell (для grid-template),
 * и сам SessionsPanel считали одно и то же.
 */
export function selectSessionsPanelCollapsed(state: RunsState): boolean {
  const runId = state.selectedId;
  if (!runId) return true;
  const explicit = state.sessionsPanelCollapsedByRun[runId];
  if (typeof explicit === 'boolean') return explicit;
  const sessionsCount = state.selectedDetails?.meta.sessions.length ?? 0;
  return sessionsCount <= 1;
}

/**
 * Открыть файл из workspace в новой вкладке редактора. Путь — строго
 * относительный от корня workspace (например, `.agents/knowledge/product/...`).
 * Используется при клике по ссылкам в карточках tool_result-ов.
 */
export function openFile(path: string): void {
  send({ type: 'editor.open', path });
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
  | {
      type: 'runs.get.result';
      id: string;
      sessionId?: string;
      meta?: RunMeta;
      chat?: ChatMessage[];
      tools?: ToolEvent[];
      pendingAsk?: PendingAsk;
      brief?: string;
      plan?: string;
    }
  | { type: 'runs.created'; meta: RunMeta }
  | { type: 'runs.error'; message: string }
  | { type: 'runs.create.aborted' }
  | { type: 'runs.updated'; meta: RunMeta }
  | { type: 'runs.askUser'; runId: string; ask: PendingAsk }
  | { type: 'runs.message.appended'; runId: string; sessionId: string; message: ChatMessage }
  | { type: 'runs.tool.appended'; runId: string; sessionId: string; event: ToolEvent }
  | { type: 'state.uiPrefs.result'; prefs: Record<string, unknown> }
  | { type: 'state.workspace.result'; hasWorkspace: boolean };

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
            runs: [data.meta, ...prev.runs.filter((run) => run.id !== data.meta.id)],
            selectedId: data.meta.id,
            // Свежесозданный ран автоматически открывает свой run-details:
            // если до этого main-area висела в режиме 'new-run' (форма
            // создания) — после успешного создания возвращаемся в детали.
            mainAreaMode: 'run-details',
            selectedDetails: { meta: data.meta, chat: [], tools: [] },
            pendingAsk: undefined,
            createRunPending: false,
            createRunError: undefined,
          }));
          return;
        }
        case 'runs.create.aborted': {
          // Пользователь отменил ввод ключа OpenRouter — снимаем loading
          // с формы, текст и заголовок остаются, ошибки нет (это не сбой).
          setState((prev) => (prev.createRunPending ? { ...prev, createRunPending: false } : prev));
          return;
        }
        case 'state.workspace.result': {
          setState((prev) =>
            prev.hasWorkspace === data.hasWorkspace
              ? prev
              : { ...prev, hasWorkspace: data.hasWorkspace }
          );
          return;
        }
        case 'state.uiPrefs.result': {
          // Восстанавливаем сохранённое состояние левого сайдбара и
          // per-run префов панели сессий (#0019). Per-run собираем по
          // префиксу `sessionsPanel.collapsed.<runId>` — extension
          // отдаёт всю мапу одной пачкой, по ней проходимся в один цикл.
          setState((prev) => {
            const left = data.prefs[UI_PREF_KEYS.leftPanelCollapsed];
            const sessionsByRun: Record<string, boolean> = {
              ...prev.sessionsPanelCollapsedByRun,
            };
            for (const [key, value] of Object.entries(data.prefs)) {
              if (!key.startsWith(SESSIONS_PANEL_PREF_PREFIX)) continue;
              if (typeof value !== 'boolean') continue;
              sessionsByRun[key.slice(SESSIONS_PANEL_PREF_PREFIX.length)] = value;
            }
            return {
              ...prev,
              leftPanelCollapsed: typeof left === 'boolean' ? left : prev.leftPanelCollapsed,
              sessionsPanelCollapsedByRun: sessionsByRun,
            };
          });
          return;
        }
        case 'runs.get.result': {
          // Принимаем только если ответ соответствует текущему выбору —
          // иначе старый медленный ответ перетрёт свежий выбор пользователя.
          setState((prev) => {
            if (prev.selectedId !== data.id) return prev;
            // Если пользователь успел кликнуть по другому табу пока этот
            // ответ ехал — игнорируем. selectedSessionId === undefined
            // означает «активная по умолчанию», в этом случае принимаем
            // любую сессию (фактически придёт активная).
            if (
              prev.selectedSessionId !== undefined &&
              data.sessionId !== undefined &&
              prev.selectedSessionId !== data.sessionId
            ) {
              return prev;
            }
            if (!data.meta) {
              return {
                ...prev,
                selectedDetails: undefined,
                pendingAsk: undefined,
                selectedBrief: undefined,
                selectedPlan: undefined,
              };
            }
            return {
              ...prev,
              // selectedSessionId не перезаписываем из ответа: undefined =
              // «follow active», явный id ставится только при клике по
              // табу (selectSession). Это нужно, чтобы handoff
              // (active меняется с продактовой на bridge) автоматически
              // переключал просмотр пользователя на новую сессию.
              selectedDetails: {
                meta: data.meta,
                chat: data.chat ?? [],
                tools: data.tools ?? [],
              },
              pendingAsk: data.pendingAsk,
              selectedBrief: data.brief,
              selectedPlan: data.plan,
            };
          });
          return;
        }
        case 'runs.updated': {
          // Если активная сессия рана сменилась (например, handoff
          // продакт→архитектор создал bridge — #0012) И пользователь в
          // follow-mode (selectedSessionId === undefined) — нужно
          // перечитать chat/tools для новой активной сессии. Делаем
          // ДО setState, чтобы запрос ушёл сразу; ответ перетрёт ленту
          // через runs.get.result.
          const prevSnapshot = state;
          if (
            prevSnapshot.selectedId === data.meta.id &&
            prevSnapshot.selectedSessionId === undefined &&
            prevSnapshot.selectedDetails &&
            prevSnapshot.selectedDetails.meta.activeSessionId !== data.meta.activeSessionId
          ) {
            send({ type: 'runs.get', id: data.meta.id });
          }
          setState((prev) => {
            const runs = prev.runs.map((run) => (run.id === data.meta.id ? data.meta : run));
            // Если меняется выбранный ран — обновляем и meta в деталях,
            // chat/tools не трогаем (они догонятся отдельными сообщениями
            // или придут целиком из runs.get выше при смене активной сессии).
            const selectedDetails =
              prev.selectedId === data.meta.id && prev.selectedDetails
                ? { ...prev.selectedDetails, meta: data.meta }
                : prev.selectedDetails;
            // Если ран ушёл из awaiting_user_input — снимаем pendingAsk.
            const clearPending = data.meta.status !== 'awaiting_user_input';
            const pendingByRun = { ...prev.pendingByRun };
            if (clearPending) delete pendingByRun[data.meta.id];
            return {
              ...prev,
              runs,
              selectedDetails,
              pendingAsk:
                clearPending && prev.selectedId === data.meta.id ? undefined : prev.pendingAsk,
              pendingByRun,
            };
          });
          return;
        }
        case 'runs.askUser': {
          setState((prev) => ({
            ...prev,
            pendingByRun: { ...prev.pendingByRun, [data.runId]: data.ask },
            pendingAsk: prev.selectedId === data.runId ? data.ask : prev.pendingAsk,
          }));
          return;
        }
        case 'runs.message.appended': {
          setState((prev) => {
            // Применяем live-приращение, только если открыт этот ран И
            // sessionId события совпадает с просматриваемой сессией
            // (selectedSessionId явный = он, undefined = активная). Это
            // нужно, чтобы обновления одной сессии не подмешивались в
            // чужие табы (#0012).
            if (
              prev.selectedId !== data.runId ||
              !prev.selectedDetails ||
              prev.selectedDetails.meta.id !== data.runId
            ) {
              return prev;
            }
            const viewedSessionId =
              prev.selectedSessionId ?? prev.selectedDetails.meta.activeSessionId;
            if (viewedSessionId !== data.sessionId) return prev;
            return {
              ...prev,
              selectedDetails: {
                ...prev.selectedDetails,
                chat: [...prev.selectedDetails.chat, data.message],
              },
            };
          });
          return;
        }
        case 'runs.tool.appended': {
          setState((prev) => {
            if (
              prev.selectedId !== data.runId ||
              !prev.selectedDetails ||
              prev.selectedDetails.meta.id !== data.runId
            ) {
              return prev;
            }
            const viewedSessionId =
              prev.selectedSessionId ?? prev.selectedDetails.meta.activeSessionId;
            if (viewedSessionId !== data.sessionId) return prev;
            return {
              ...prev,
              selectedDetails: {
                ...prev.selectedDetails,
                tools: [...prev.selectedDetails.tools, data.event],
              },
            };
          });
          return;
        }
        case 'runs.error': {
          // Ошибки уже показывает extension через showErrorMessage.
          // Здесь дополнительно ловим её в форму создания, если она
          // прилетела во время `runs.create` — иначе пользователь не
          // увидел бы причину под кнопкой «Запустить» (#0018 acceptance).
          // Эвристика «pending => относится к create» безопасна: другие
          // потоки (user.message и т.п.) не выставляют createRunPending.
          console.error('[runs]', data.message);
          setState((prev) =>
            prev.createRunPending
              ? { ...prev, createRunPending: false, createRunError: data.message }
              : prev
          );
          return;
        }
        default:
          return;
      }
    };

    window.addEventListener('message', onMessage);

    // На первом старте на узком окне сворачиваем левый сайдбар, чтобы
    // он не съедал ширину main-area. Правую панель сессий не трогаем —
    // её collapsed-state теперь per-run и считается в селекторе по
    // количеству сессий (см. selectSessionsPanelCollapsed).
    if (typeof window !== 'undefined' && window.innerWidth < NARROW_WINDOW_PX) {
      setState((prev) => ({ ...prev, leftPanelCollapsed: true }));
    }

    // При первом монтировании сразу запрашиваем актуальный список —
    // иначе при открытии webview пользователь увидит пустой экран.
    requestRunsList();
    // И параллельно — сохранённые UI-префы. Ответ перетрёт дефолты
    // выше, если пользователь раньше явно менял состояние сайдбаров.
    send({ type: 'state.getUiPrefs' });
    // Опрашиваем workspace — без открытой папки кнопка «+ Новый ран»
    // должна стоять disabled (#0018 / US-5).
    send({ type: 'state.getWorkspace' });

    return () => window.removeEventListener('message', onMessage);
  }, []);
}

/** Хук-чтение всего state. Возвращает стабильный снапшот. */
export function useRunsState(): RunsState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
