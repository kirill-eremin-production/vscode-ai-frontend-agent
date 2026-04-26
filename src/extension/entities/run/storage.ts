import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import {
  EMPTY_USAGE,
  type ChatMessage,
  type Participant,
  type RunMeta,
  type RunStatus,
  type SessionKind,
  type SessionMeta,
  type SessionSummary,
  type UsageAggregate,
} from './types';

/**
 * Файловое хранилище ранов.
 *
 * Структура диска:
 *   .agents/
 *     knowledge/                        # общая база знаний (kb)
 *       product/briefs/<runId>-<slug>.md  # продуктовые артефакты (#0011)
 *     runs/<runId>/
 *       meta.json                       # RunMeta (см. types.ts) +
 *                                       # `briefPath` — ссылка в kb
 *       sessions/<sessionId>/
 *         meta.json                     # SessionMeta
 *         chat.jsonl                    # лента сообщений сессии
 *         tools.jsonl                   # tool-события сессии
 *         loop.json                     # конфиг agent-loop'а сессии
 *
 * Inhabit'ить `.agents/` решено в корне открытого workspace — это ровно
 * то, что обещали пользователю («синхронизация через документацию прямо
 * в его проекте»). База данных или globalStorage сюда не подходят:
 * артефакты должны лежать рядом с кодом, который агенты правят, и
 * попадать в git вместе с ним.
 */

const ROOT_DIR_NAME = '.agents';
const RUNS_DIR_NAME = 'runs';
const SESSIONS_DIR_NAME = 'sessions';
const KNOWLEDGE_DIR_NAME = 'knowledge';
const META_FILE = 'meta.json';
const CHAT_FILE = 'chat.jsonl';
const TOOLS_FILE = 'tools.jsonl';
const LOOP_FILE = 'loop.json';

/** Подкаталог в kb для брифов продакта (#0011). */
const PRODUCT_BRIEFS_DIR = path.join('product', 'briefs');
/** Подкаталог в kb для планов архитектора (#0004). */
const ARCHITECT_PLANS_DIR = path.join('architect', 'plans');
/** Подкаталог в kb для сводок программиста (#0027). */
const PROGRAMMER_SUMMARIES_DIR = path.join('programmer', 'summaries');

/**
 * Кастомная ошибка хранилища — на случаях, когда дальнейшая работа
 * невозможна без действия пользователя (нет открытого workspace, нет
 * активной сессии и т.п.). Отдельный тип нужен, чтобы IPC-слой мог
 * отличить такие ошибки от случайных багов и показать понятное сообщение.
 */
export class RunStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStorageError';
  }
}

/* ── Workspace + path helpers ───────────────────────────────────── */

function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new RunStorageError(
      'Откройте папку в VS Code, чтобы создавать раны (нужно место для .agents/)'
    );
  }
  return folders[0].uri.fsPath;
}

function getRunsRoot(): string {
  return path.join(getWorkspaceRoot(), ROOT_DIR_NAME, RUNS_DIR_NAME);
}

function getRunDir(runId: string): string {
  return path.join(getRunsRoot(), runId);
}

function getSessionsDir(runId: string): string {
  return path.join(getRunDir(runId), SESSIONS_DIR_NAME);
}

function getSessionDir(runId: string, sessionId: string): string {
  return path.join(getSessionsDir(runId), sessionId);
}

/**
 * Корень knowledge base всех ролей. Используется тулами `kb.*` через
 * хелпер `resolveKnowledgePath` — отдаёт абсолютный путь и на нём же
 * проверяется sandbox (никакого `..` за пределы этой директории).
 */
export function getKnowledgeRoot(): string {
  return path.join(getWorkspaceRoot(), ROOT_DIR_NAME, KNOWLEDGE_DIR_NAME);
}

/**
 * Резолвить путь внутри knowledge base и проверить sandbox.
 * Возвращает абсолютный путь, гарантированно лежащий внутри
 * `.agents/knowledge/`. Бросает `RunStorageError` при попытке выхода.
 */
export function resolveKnowledgePath(relativePath: string): string {
  const root = getKnowledgeRoot();
  const resolved = path.resolve(root, relativePath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new RunStorageError(
      `Путь "${relativePath}" выходит за пределы .agents/knowledge/ — sandbox запрещён`
    );
  }
  return resolved;
}

/* ── Atomic write helper ────────────────────────────────────────── */

/**
 * Атомарная запись JSON: tmp-файл → rename. Защищает от обрыва (kill
 * процесса посреди записи) — на диске всегда либо старое содержимое,
 * либо новое, никогда полу-записанное.
 */
async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

/* ── Session id + summary helpers ───────────────────────────────── */

/**
 * Сгенерировать id новой сессии. Префикс `s_` отделяет сессии в логах
 * от runId (которые префикса не имеют), формат — короткий random hex,
 * чтобы был валиден как имя папки на всех ОС и не путал глаз.
 */
function generateSessionId(): string {
  return `s_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Свести SessionMeta до SessionSummary для записи в RunMeta. Зеркальная
 * операция: читать SessionMeta для шапки рана дорого (N файлов), а
 * summary на ран один (в `runs/<id>/meta.json`).
 */
function toSummary(session: SessionMeta): SessionSummary {
  return {
    id: session.id,
    kind: session.kind,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    parentSessionId: session.parentSessionId,
    usage: session.usage,
    participants: session.participants,
    inputFrom: session.inputFrom,
    prev: session.prev,
    next: session.next,
  };
}

/**
 * Пересчитать агрегат usage по всем сессиям. Используется при любом
 * обновлении сессионного usage — RunMeta.usage держим как сумму, чтобы
 * UI мог показывать total без чтения каждой сессии.
 *
 * costUsd: если хотя бы у одной сессии `null` — итог тоже `null`
 * (правило «один неизвестный тариф ⇒ итог неизвестен»).
 */
function aggregateRunUsage(sessions: SessionSummary[]): UsageAggregate {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = 0;
  let lastTotalTokens = 0;
  let lastModel: string | null = null;
  let lastUpdated = '';
  for (const s of sessions) {
    inputTokens += s.usage.inputTokens;
    outputTokens += s.usage.outputTokens;
    if (costUsd !== null && s.usage.costUsd !== null) {
      costUsd += s.usage.costUsd;
    } else {
      costUsd = null;
    }
    // «last» по runtime: берём из самой свежей по updatedAt сессии.
    if (s.updatedAt > lastUpdated) {
      lastUpdated = s.updatedAt;
      lastTotalTokens = s.usage.lastTotalTokens;
      lastModel = s.usage.lastModel;
    }
  }
  return { inputTokens, outputTokens, costUsd, lastTotalTokens, lastModel };
}

/* ── Legacy participants normalization (#0034) ──────────────────── */

/**
 * Восстановить `participants` из легаси-полей старого session-meta.
 *
 * До #0034 пара участников могла храниться полем `agentRole: string` без
 * явного массива (а ещё раньше — вообще без участников, только тип `kind`).
 * Чтобы новый код не делал `?? []`-проверок повсюду и не получал пустой
 * массив, на чтении подменяем недостающее на массив длины 2 — единственный
 * исторический случай (комнаты с 3+ участниками появились вместе с этой же
 * задачей).
 *
 * Правила нормализации:
 *  - если `participants` уже непустой массив — оставляем как есть;
 *  - иначе для `kind === 'agent-agent'` собираем `[product, architect]`
 *    (исторически единственная пара мостов на момент legacy-формата);
 *  - иначе (user-agent или неизвестный kind) — `[user, agent:<role>]`,
 *    где `<role>` берётся из `agentRole` или дефолт 'product'.
 *
 * Файл на диске не переписывается — нормализация чистая, только в памяти.
 */
function normalizeParticipants(
  raw: { participants?: unknown; agentRole?: unknown; kind?: unknown } | null | undefined
): Participant[] {
  const list = (raw?.participants as Participant[] | undefined) ?? [];
  if (Array.isArray(list) && list.length > 0) return list;

  const legacyRole = typeof raw?.agentRole === 'string' ? raw.agentRole : 'product';
  if (raw?.kind === 'agent-agent') {
    return [
      { kind: 'agent', role: legacyRole },
      { kind: 'agent', role: legacyRole === 'product' ? 'architect' : 'product' },
    ];
  }
  return [{ kind: 'user' }, { kind: 'agent', role: legacyRole }];
}

/**
 * Восстановить `prev` и `next` из legacy-полей.
 *
 * До #0035 родительство хранилось одним полем `parentSessionId`, а
 * списка дочерних сессий не было вовсе (UI вычислял на лету). После
 * #0035 источник правды — `prev[]`/`next[]`; `parentSessionId` живёт
 * как алиас для обратной совместимости (см. SessionMeta).
 *
 * Правила нормализации (на уровне одной сессии, без знания о соседях):
 *  - если массив `prev` уже валидный — оставляем;
 *  - иначе берём `parentSessionId` (если есть) → `[parentSessionId]`,
 *    в противном случае — пустой массив (корневая сессия);
 *  - `next` — пустой массив. Полная инверсия по всем сессиям рана
 *    делается отдельным шагом в `normalizeRunSessionsList`.
 */
function readPrevFromLegacy(raw: { prev?: unknown; parentSessionId?: unknown }): string[] {
  if (Array.isArray(raw.prev) && raw.prev.every((entry) => typeof entry === 'string')) {
    return raw.prev as string[];
  }
  if (typeof raw.parentSessionId === 'string' && raw.parentSessionId.length > 0) {
    return [raw.parentSessionId];
  }
  return [];
}

function readNextFromLegacy(raw: { next?: unknown }): string[] {
  if (Array.isArray(raw.next) && raw.next.every((entry) => typeof entry === 'string')) {
    return raw.next as string[];
  }
  return [];
}

/**
 * Безопасный фолбэк `inputFrom` для одиночной сессии. Без знания о
 * родителе вывести роль автора входа невозможно — возвращаем `'user'`
 * как корневой источник по умолчанию (#0035). Уточнение по родителю
 * выполняется в `normalizeRunSessionsList`.
 */
function readInputFromLegacy(raw: { inputFrom?: unknown }): string {
  if (typeof raw.inputFrom === 'string' && raw.inputFrom.length > 0) {
    return raw.inputFrom;
  }
  return 'user';
}

/**
 * Привести SessionMeta из старого формата к актуальному. Идемпотентно:
 * если participants/prev/next/inputFrom уже корректные — возвращает
 * исходный объект (по ссылке).
 */
function normalizeSessionMeta(raw: SessionMeta): SessionMeta {
  const rawRecord = raw as unknown as Record<string, unknown>;
  const participants = normalizeParticipants(rawRecord);
  const prev = readPrevFromLegacy(rawRecord);
  const next = readNextFromLegacy(rawRecord);
  const inputFrom = readInputFromLegacy(rawRecord);
  if (
    raw.participants === participants &&
    raw.prev === prev &&
    raw.next === next &&
    raw.inputFrom === inputFrom
  ) {
    return raw;
  }
  return { ...raw, participants, prev, next, inputFrom };
}

/**
 * Привести SessionSummary в RunMeta.sessions[] к актуальному формату.
 * До #0034 поле `participants` в summary было опциональным — после миграции
 * всегда массив длины ≥ 1. Используется в `readMeta`, чтобы webview не
 * получал summary без участников (часть UI завязана на их наличие).
 *
 * #0035 добавляет `prev`/`next`/`inputFrom`: для legacy-summary без этих
 * полей восстанавливаем их по тем же правилам, что и в SessionMeta.
 */
function normalizeSessionSummary(raw: SessionSummary): SessionSummary {
  const rawRecord = raw as unknown as Record<string, unknown>;
  const participants = normalizeParticipants(rawRecord);
  const prev = readPrevFromLegacy(rawRecord);
  const next = readNextFromLegacy(rawRecord);
  const inputFrom = readInputFromLegacy(rawRecord);
  if (
    raw.participants === participants &&
    raw.prev === prev &&
    raw.next === next &&
    raw.inputFrom === inputFrom
  ) {
    return raw;
  }
  return { ...raw, participants, prev, next, inputFrom };
}

/**
 * Извлечь роль автора входа из участника. `user` отдаём как литерал
 * `'user'`; для агента — его роль (`product`/`architect`/...).
 */
function participantToInputFrom(participant: Participant): string {
  return participant.kind === 'user' ? 'user' : participant.role;
}

/**
 * Дополнить нормализацию `next`/`inputFrom` информацией о всех сессиях
 * рана. Делается одним проходом при `readMeta`/`listAllMeta`:
 *
 *  - `next` каждой сессии переcчитывается обратным индексом по `prev`
 *    всех сессий рана. Это страхует от рассинхрона на legacy-данных,
 *    где `next` либо отсутствует, либо устарел (запись родителя могла
 *    не дойти до диска до краша). Для свежих ранов результат идентичен
 *    тому, что лежит на диске, — пересчёт идемпотентен.
 *  - `inputFrom` уточняется через родительские `participants`: для
 *    bridge/handoff-сессии = роль `participants[0]` родителя, для
 *    корневой остаётся `'user'`. Если родитель не найден в списке
 *    (битые ссылки) — оставляем то, что было (или фолбэк `'user'`).
 */
function normalizeRunSessionsList(sessions: SessionSummary[]): SessionSummary[] {
  // Шаг 1: собираем родительские summary в индекс по id.
  const byId = new Map<string, SessionSummary>();
  for (const session of sessions) byId.set(session.id, session);

  // Шаг 2: обратный индекс prev → дети, для пересчёта `next`.
  const childrenByParent = new Map<string, string[]>();
  for (const session of sessions) {
    for (const parentId of session.prev) {
      const list = childrenByParent.get(parentId) ?? [];
      list.push(session.id);
      childrenByParent.set(parentId, list);
    }
  }

  // Шаг 3: для каждой сессии — пересчёт next и уточнение inputFrom.
  return sessions.map((session) => {
    const next = childrenByParent.get(session.id) ?? [];
    let inputFrom = session.inputFrom;
    const parentId = session.prev[0];
    if (parentId !== undefined) {
      const parent = byId.get(parentId);
      // participants[0] — устоявшийся «инициатор» по правилам #0034:
      // первый элемент остаётся стабильным при добавлении новых
      // участников через addParticipant (push в конец). Если у родителя
      // participants пуст (битые legacy-данные) — используем то, что
      // было записано на диске, чтобы не затереть валидное значение
      // фолбэком.
      if (parent && parent.participants.length > 0) {
        inputFrom = participantToInputFrom(parent.participants[0]);
      }
    } else {
      // Корневая сессия (без родителей) всегда `'user'` — это её
      // инициатор по определению ленты встреч (#0029).
      inputFrom = 'user';
    }

    if (
      session.next.length === next.length &&
      session.next.every((id, index) => id === next[index]) &&
      session.inputFrom === inputFrom
    ) {
      return session;
    }
    return { ...session, next, inputFrom };
  });
}

/* ── Run meta read/write ────────────────────────────────────────── */

/**
 * Прочитать meta.json одного рана. Возвращает undefined, если файла
 * нет или JSON битый — список ранов не должен падать целиком из-за
 * одной повреждённой папки.
 *
 * После #0034 — нормализуем `sessions[].participants` для legacy-файлов:
 * вызывающий код всегда получает summary с непустым массивом участников.
 */
export async function readMeta(runId: string): Promise<RunMeta | undefined> {
  const filePath = path.join(getRunDir(runId), META_FILE);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as RunMeta;
    const summaries = Array.isArray(parsed.sessions)
      ? parsed.sessions.map(normalizeSessionSummary)
      : [];
    // Второй проход — кросс-сессионная нормализация next/inputFrom (#0035):
    // отдельная фаза, потому что её аргумент — весь список сессий рана,
    // а не одиночный summary. См. `normalizeRunSessionsList`.
    const sessions = normalizeRunSessionsList(summaries);
    return { ...parsed, sessions };
  } catch {
    return undefined;
  }
}

/** Атомарно записать RunMeta. */
export async function writeMeta(meta: RunMeta): Promise<void> {
  await writeJsonAtomic(path.join(getRunDir(meta.id), META_FILE), meta);
}

/**
 * Прочитать meta.json всех ранов. Сортируем по убыванию `createdAt` —
 * естественный порядок для UI-списка (свежие сверху).
 */
export async function listAllMeta(): Promise<RunMeta[]> {
  const root = getRunsRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const metas: RunMeta[] = [];
  for (const entry of entries) {
    const meta = await readMeta(entry);
    if (meta) metas.push(meta);
  }
  metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return metas;
}

/* ── Run + session init ─────────────────────────────────────────── */

/**
 * Параметры начальной сессии при создании рана. Сейчас всегда продакт +
 * пользователь; после #0012 (мульти-агент) появятся другие комбинации.
 */
export interface InitialSessionParams {
  kind: SessionKind;
  participants: Participant[];
  /** Стартовый статус сессии. По умолчанию `draft`. */
  status?: RunStatus;
}

/**
 * Создать директорию рана + первую сессию. Возвращает RunMeta, в которой
 * `activeSessionId` указывает на свежесозданную сессию.
 *
 * Параметры:
 *  - `meta` — заготовка RunMeta без полей `activeSessionId`, `sessions`,
 *    `usage` (они проставляются здесь).
 *  - `initial` — описание первой сессии.
 *
 * `recursive: true` нужен, чтобы не падать на первом ране: `.agents/runs/`
 * ещё не существует. Внутри session-меты статус начально совпадает с
 * `meta.status` — синхронизация активной сессии и рана начинается с init.
 */
export async function initRunDir(
  meta: Omit<RunMeta, 'activeSessionId' | 'sessions' | 'usage'>,
  initial: InitialSessionParams
): Promise<RunMeta> {
  const sessionId = generateSessionId();
  const runDir = getRunDir(meta.id);
  const sessionDir = getSessionDir(meta.id, sessionId);
  await fs.mkdir(sessionDir, { recursive: true });

  const status = initial.status ?? meta.status;
  const now = new Date().toISOString();
  const sessionMeta: SessionMeta = {
    id: sessionId,
    runId: meta.id,
    kind: initial.kind,
    participants: initial.participants,
    // Корневая сессия рана: входа извне нет, инициатор — пользователь;
    // prev/next пусты до первого handoff'а (#0035).
    inputFrom: 'user',
    prev: [],
    next: [],
    status,
    createdAt: now,
    updatedAt: now,
    usage: { ...EMPTY_USAGE },
  };
  await writeJsonAtomic(path.join(sessionDir, META_FILE), sessionMeta);
  // chat.jsonl создаём пустым, чтобы append-операции работали без
  // проверки существования.
  await fs.writeFile(path.join(sessionDir, CHAT_FILE), '', { flag: 'a' });

  const summary = toSummary(sessionMeta);
  const runMeta: RunMeta = {
    ...meta,
    status, // зеркало активной сессии
    activeSessionId: sessionId,
    sessions: [summary],
    usage: aggregateRunUsage([summary]),
  };
  // Run dir уже создан вложенным mkdir выше — пишем meta.json.
  await writeJsonAtomic(path.join(runDir, META_FILE), runMeta);
  return runMeta;
}

/**
 * Создать новую сессию в существующем ране и сделать её активной.
 * Используется компактификацией (#0013) и в будущем — мульти-агентом
 * (#0012, agent-agent сессии).
 *
 * До этого момента ран должен быть инициализирован через `initRunDir`,
 * иначе будет ошибка чтения RunMeta.
 */
export async function createSession(
  runId: string,
  params: {
    kind: SessionKind;
    participants: Participant[];
    /**
     * Родительская сессия (legacy-алиас на `prev[0]`). Оставлен для
     * обратной совместимости с вызовами до #0035; новые сценарии могут
     * использовать `prev`. Если переданы оба — `prev` приоритетнее.
     */
    parentSessionId?: string;
    /**
     * Список родительских сессий (#0035). Длина 1 для обычной handoff/
     * compact-цепочки; задел под слияние веток в одну встречу. По
     * умолчанию вычисляется из `parentSessionId` (для совместимости).
     */
    prev?: string[];
    status?: RunStatus;
  }
): Promise<{ run: RunMeta; session: SessionMeta }> {
  const run = await readMeta(runId);
  if (!run) {
    throw new RunStorageError(`Ран ${runId} не найден — нельзя создать сессию`);
  }

  // prev — основной источник правды; parentSessionId оставляем как
  // вычисляемый алиас, чтобы старый UI/storage-код не сломался.
  const prev = params.prev ?? (params.parentSessionId ? [params.parentSessionId] : []);
  const parentSessionId = prev[0];

  // inputFrom выводится из участника-инициатора родительской сессии
  // (`participants[0]`): продакт передал бриф → 'product', архитектор
  // план → 'architect'. Для корневой сессии и битых ссылок — 'user'.
  const parentSummary = parentSessionId
    ? run.sessions.find((session) => session.id === parentSessionId)
    : undefined;
  const inputFrom =
    parentSummary && parentSummary.participants.length > 0
      ? participantToInputFrom(parentSummary.participants[0])
      : 'user';

  const sessionId = generateSessionId();
  const sessionDir = getSessionDir(runId, sessionId);
  await fs.mkdir(sessionDir, { recursive: true });

  const now = new Date().toISOString();
  const sessionMeta: SessionMeta = {
    id: sessionId,
    runId,
    kind: params.kind,
    participants: params.participants,
    parentSessionId,
    inputFrom,
    prev,
    next: [],
    status: params.status ?? 'draft',
    createdAt: now,
    updatedAt: now,
    usage: { ...EMPTY_USAGE },
  };
  await writeJsonAtomic(path.join(sessionDir, META_FILE), sessionMeta);
  await fs.writeFile(path.join(sessionDir, CHAT_FILE), '', { flag: 'a' });

  // Обновляем `next` у каждой родительской сессии: и в её session-meta
  // на диске, и в summary внутри run-meta. Делаем явно, не полагаясь
  // на read-time нормализацию: следующий читатель должен видеть полный
  // граф сразу после write — это ключевая гарантия #0035 для UI журнала.
  for (const parentId of prev) {
    await appendNextToParent(runId, parentId, sessionId);
  }

  // Перечитываем run после правок родителей, чтобы summaries с
  // обновлённым `updatedAt` (родителю обновили session-meta) попали
  // в финальный RunMeta.
  const refreshedRun = (await readMeta(runId)) ?? run;
  const newSummary = toSummary(sessionMeta);
  // В summaries родителей в run-meta пишем `next` явно: read-time
  // нормализация при следующем `readMeta` всё равно пересчитает их
  // обратным индексом, но broadcast возвращает ровно эту RunMeta —
  // UI должен увидеть новый граф сразу, не дожидаясь повторного чтения.
  const prevSet = new Set(prev);
  const sessions = [
    ...refreshedRun.sessions.map((session) =>
      prevSet.has(session.id) && !session.next.includes(sessionId)
        ? { ...session, next: [...session.next, sessionId] }
        : session
    ),
    newSummary,
  ];
  const updatedRun: RunMeta = {
    ...refreshedRun,
    status: sessionMeta.status,
    activeSessionId: sessionId,
    sessions,
    usage: aggregateRunUsage(sessions),
    updatedAt: now,
  };
  await writeMeta(updatedRun);
  return { run: updatedRun, session: sessionMeta };
}

/**
 * Идемпотентно добавить id дочерней сессии в `next` родителя:
 *  - читает session-meta родителя;
 *  - если в `next` уже есть этот id — ничего не делает;
 *  - иначе: пушит и перезаписывает session-meta атомарно (новый
 *    `updatedAt` тоже бьётся — это полноценный апдейт сессии).
 *
 * Не ломает RunMeta самостоятельно: вызывающий `createSession` после
 * всех правок родителей перечитывает RunMeta и собирает финальный
 * snapshot. Это позволяет писать одной транзакцией только один файл
 * meta.json рана (атомарность временных гарантий).
 */
async function appendNextToParent(
  runId: string,
  parentSessionId: string,
  childSessionId: string
): Promise<void> {
  const parent = await readSessionMeta(runId, parentSessionId);
  if (!parent) return;
  if (parent.next.includes(childSessionId)) return;
  const updatedParent: SessionMeta = {
    ...parent,
    next: [...parent.next, childSessionId],
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(path.join(getSessionDir(runId, parentSessionId), META_FILE), updatedParent);
}

/* ── Session meta read/update ───────────────────────────────────── */

/**
 * Прочитать SessionMeta. Undefined — нет такой сессии (или JSON битый).
 *
 * После #0034 — нормализуем `participants` для legacy-файлов (см.
 * `normalizeSessionMeta`): вызывающий код всегда получает массив
 * длины ≥ 1, даже если на диске участники не сохранены явно.
 */
export async function readSessionMeta(
  runId: string,
  sessionId: string
): Promise<SessionMeta | undefined> {
  const filePath = path.join(getSessionDir(runId, sessionId), META_FILE);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return normalizeSessionMeta(JSON.parse(raw) as SessionMeta);
  } catch {
    return undefined;
  }
}

/**
 * Атомарно обновить SessionMeta И синхронизировать с RunMeta:
 *  - в `sessions[]` рана обновляется summary этой сессии;
 *  - если сессия активная, RunMeta.status тоже обновляется;
 *  - RunMeta.usage пересчитывается из всех сессий;
 *  - RunMeta.updatedAt бьётся.
 *
 * Возвращает обновлённую RunMeta — её обычно тут же broadcast'ит UI.
 * Если сессии нет — undefined (вызывающий код должен это обработать).
 */
async function persistSessionUpdate(
  runId: string,
  session: SessionMeta
): Promise<RunMeta | undefined> {
  await writeJsonAtomic(path.join(getSessionDir(runId, session.id), META_FILE), session);
  const run = await readMeta(runId);
  if (!run) return undefined;
  const sessions = run.sessions.map((s) => (s.id === session.id ? toSummary(session) : s));
  const isActive = run.activeSessionId === session.id;
  const updatedRun: RunMeta = {
    ...run,
    status: isActive ? session.status : run.status,
    sessions,
    usage: aggregateRunUsage(sessions),
    updatedAt: new Date().toISOString(),
  };
  await writeMeta(updatedRun);
  return updatedRun;
}

/**
 * Получить id активной сессии. Бросает RunStorageError, если ран не
 * найден — это всегда баг вызывающего кода (он работает с runId, который
 * не существует).
 */
async function getActiveSessionIdOrThrow(runId: string): Promise<string> {
  const meta = await readMeta(runId);
  if (!meta) {
    throw new RunStorageError(`Ран ${runId} не найден`);
  }
  return meta.activeSessionId;
}

/**
 * Перевести **активную** сессию рана в новый статус. Сохраняет копию
 * статуса в RunMeta. Возвращает обновлённую RunMeta для broadcast'а.
 *
 * Удобный фасад: 99% вызывающего кода (agent-loop, ask_user, finalize)
 * хочет менять статус «текущей работы», а не конкретной сессии по id.
 * Если когда-то понадобится менять статус неактивной сессии — есть
 * `setSessionStatus`, который явно принимает sessionId.
 */
export async function updateRunStatus(
  runId: string,
  status: RunStatus
): Promise<RunMeta | undefined> {
  const sessionId = await getActiveSessionIdOrThrow(runId).catch(() => undefined);
  if (!sessionId) return undefined;
  return setSessionStatus(runId, sessionId, status);
}

/** Перевести конкретную сессию в новый статус. */
export async function setSessionStatus(
  runId: string,
  sessionId: string,
  status: RunStatus
): Promise<RunMeta | undefined> {
  const session = await readSessionMeta(runId, sessionId);
  if (!session) return undefined;
  const updated: SessionMeta = {
    ...session,
    status,
    updatedAt: new Date().toISOString(),
  };
  return persistSessionUpdate(runId, updated);
}

/**
 * Идемпотентно добавить участника в `participants` сессии. Никаких
 * правок, если такой участник уже есть (сравниваем по `kind`+`role`).
 *
 * Используется в #0012, когда пользователь впервые пишет в agent-agent
 * сессию: bridge превращается в hybrid (`participants` пополняется
 * `{kind:'user'}`). Для UI это сигнал «теперь это смешанный канал»;
 * для будущих ролей-наблюдателей — формальное право участвовать.
 *
 * Возвращает обновлённую RunMeta, если изменение применилось, и
 * undefined, если participants уже содержал этого участника (или
 * сессии нет).
 */
export async function addParticipant(
  runId: string,
  sessionId: string,
  participant: Participant
): Promise<RunMeta | undefined> {
  const session = await readSessionMeta(runId, sessionId);
  if (!session) return undefined;
  const exists = session.participants.some((p) =>
    p.kind === 'user'
      ? participant.kind === 'user'
      : participant.kind === 'agent' && p.role === participant.role
  );
  if (exists) return undefined;
  const updated: SessionMeta = {
    ...session,
    participants: [...session.participants, participant],
    updatedAt: new Date().toISOString(),
  };
  return persistSessionUpdate(runId, updated);
}

/**
 * «Втащить» агентскую роль в сессию-комнату (#0036).
 *
 * Базовый кирпич для будущих тулов `team.invite` (#0037) и `team.escalate`
 * (#0038): добавляет роль в `participants` и пишет системное событие
 * `participant_joined` в журнал сессии (`tools.jsonl`).
 *
 * Идемпотентность: если роль уже среди `participants` — no-op (возвращает
 * undefined, ничего на диск не пишется и событие не дублируется). Это
 * нужно, чтобы вышестоящие тулы могли вызывать pullIntoRoom бездумно,
 * без предварительной проверки членства.
 *
 * Возвращает обновлённую RunMeta — вызывающий код (#0037/#0038/IPC-уровень)
 * сделает broadcast `runs.updated`, чтобы подписчики увидели новый состав
 * `participants` без отдельного `readMeta`.
 *
 * Атомарность: запись участников и события — две независимых операции
 * (session-meta + tools.jsonl). Если первая прошла, а вторая упала —
 * на диске останется лишний участник без события в журнале. Считаем
 * приемлемым: альтернатива (двухфазный коммит через временный лог)
 * слишком тяжёлая для текущей итерации, а реальные сбои на этом этапе
 * крайне редки.
 */
export async function pullIntoRoom(
  runId: string,
  sessionId: string,
  role: string
): Promise<RunMeta | undefined> {
  // addParticipant сам обеспечивает идемпотентность: undefined ⇒ роль
  // уже есть, ничего не меняли. На undefined событие НЕ пишем —
  // ровно поэтому повторный вызов не дублирует запись в журнале.
  const updated = await addParticipant(runId, sessionId, { kind: 'agent', role });
  if (!updated) return undefined;
  const event: ToolEvent = {
    kind: 'participant_joined',
    at: new Date().toISOString(),
    role,
  };
  // Запись события — после participants: читатели сначала видят
  // согласованный список участников, затем — пометку «когда добавили».
  await appendToolEvent(runId, event, sessionId);
  return updated;
}

/**
 * Сменить активную сессию рана (используется компактификацией).
 * При успехе RunMeta.status тоже синхронизируется со статусом новой
 * активной сессии.
 */
export async function setActiveSession(
  runId: string,
  sessionId: string
): Promise<RunMeta | undefined> {
  const run = await readMeta(runId);
  if (!run) return undefined;
  const session = await readSessionMeta(runId, sessionId);
  if (!session) {
    throw new RunStorageError(`Сессия ${sessionId} не найдена в ране ${runId}`);
  }
  const updatedRun: RunMeta = {
    ...run,
    activeSessionId: sessionId,
    status: session.status,
    updatedAt: new Date().toISOString(),
  };
  await writeMeta(updatedRun);
  return updatedRun;
}

/* ── Loop config (per-session) ──────────────────────────────────── */

/**
 * Конфиг agent-loop'а, нужный для возобновления цикла после
 * перезапуска VS Code. Пишется в `loop.json` сессии при старте,
 * читается в `resumeRun` после ответа пользователя.
 *
 * Лежит на уровне сессии, потому что компактификация (#0013) создаёт
 * новую сессию с тем же базовым конфигом (model/role), но другим
 * `userMessage` (= summary предыдущей сессии).
 */
export interface LoopConfig {
  model: string;
  systemPrompt: string;
  toolNames: string[];
  userMessage: string;
  /** Идентификатор роли для регистрации resumer'а (`product`, `smoke`, …). */
  role: string;
  temperature?: number;
}

/** Записать loop.json активной сессии (или конкретной, если указано). */
export async function writeLoopConfig(
  runId: string,
  config: LoopConfig,
  sessionId?: string
): Promise<void> {
  const sid = sessionId ?? (await getActiveSessionIdOrThrow(runId));
  await writeJsonAtomic(path.join(getSessionDir(runId, sid), LOOP_FILE), config);
}

/** Прочитать loop.json активной сессии (или конкретной). Undefined — нет. */
export async function readLoopConfig(
  runId: string,
  sessionId?: string
): Promise<LoopConfig | undefined> {
  const sid = sessionId ?? (await readMeta(runId).then((m) => m?.activeSessionId));
  if (!sid) return undefined;
  const filePath = path.join(getSessionDir(runId, sid), LOOP_FILE);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as LoopConfig;
  } catch {
    return undefined;
  }
}

/* ── Brief (per-run, stored in shared kb) ───────────────────────── */

/**
 * Превратить заголовок рана в безопасный slug для имени файла в kb.
 *
 * Поддерживаем юникодные буквы (включая кириллицу) — fs всех целевых ОС
 * с ними справляется, а пользователю в проводнике приятнее видеть
 * `20260426...-счётчик-кликов.md`, чем транслит. Всё, что не буква и не
 * цифра, заменяется на `-`; край-кейсы (пустой, длинный) подрезаем
 * жёстко, иначе на длинных prompt'ах получим имя файла в 200 символов.
 */
function slugifyTitle(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length === 0) return 'untitled';
  return base.length > 60 ? base.slice(0, 60).replace(/-+$/g, '') : base;
}

/**
 * Построить относительный путь брифа в kb. Возвращает путь относительно
 * workspace root: `.agents/knowledge/product/briefs/<runId>-<slug>.md`.
 * Используется и для записи, и для записи в `meta.briefPath` (UI открывает
 * файл через `editor.open`, который ожидает workspace-relative путь).
 */
function buildBriefRelativePath(runId: string, title: string): string {
  const filename = `${runId}-${slugifyTitle(title)}.md`;
  return path.join(ROOT_DIR_NAME, KNOWLEDGE_DIR_NAME, PRODUCT_BRIEFS_DIR, filename);
}

/**
 * Атомарно записать бриф в общую kb и сохранить ссылку в `meta.briefPath`.
 * Возвращает обновлённую RunMeta (для broadcast'а) и итоговый
 * workspace-relative путь.
 *
 * Почему kb, а не корень рана:
 *  - бриф — продукт работы, общий ресурс проекта; следующие роли
 *    (архитектор, программист) и сам пользователь читают его как
 *    обычный файл репозитория, не «знай идентификатор рана»;
 *  - после компактификации (#0013) и мульти-агента (#0012) сессии
 *    одного рана не должны драться за `brief.md` в каждой папке.
 *
 * Имя файла включает `runId`, чтобы один проект мог накопить несколько
 * брифов от разных ранов без коллизий. Slug добавлен для читаемости
 * в проводнике/git-blame.
 */
export async function writeBrief(
  runId: string,
  title: string,
  content: string
): Promise<{ run: RunMeta | undefined; briefPath: string }> {
  const relPath = buildBriefRelativePath(runId, title);
  const absPath = path.join(getWorkspaceRoot(), relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, absPath);

  const run = await readMeta(runId);
  if (!run) return { run: undefined, briefPath: relPath };
  const updated: RunMeta = {
    ...run,
    briefPath: relPath,
    updatedAt: new Date().toISOString(),
  };
  await writeMeta(updated);
  return { run: updated, briefPath: relPath };
}

/**
 * Прочитать бриф рана. Undefined — `meta.briefPath` ещё не проставлен
 * (роль не финализировала ран) или файл удалён вручную. Чтение через
 * meta, а не по фиксированному пути, потому что путь зависит от title
 * рана и не вычисляется без него.
 */
export async function readBrief(runId: string): Promise<string | undefined> {
  const meta = await readMeta(runId);
  if (!meta?.briefPath) return undefined;
  const absPath = path.join(getWorkspaceRoot(), meta.briefPath);
  try {
    return await fs.readFile(absPath, 'utf8');
  } catch {
    return undefined;
  }
}

/* ── Plan (per-run, stored in shared kb) ────────────────────────── */

/**
 * Параллель `buildBriefRelativePath` для архитекторского `plan.md`.
 * Лежит в `.agents/knowledge/architect/plans/<runId>-<slug>.md` по той
 * же мотивации (#0011): артефакт — общий ресурс проекта, не привязан
 * к папке конкретного рана.
 */
function buildPlanRelativePath(runId: string, title: string): string {
  const filename = `${runId}-${slugifyTitle(title)}.md`;
  return path.join(ROOT_DIR_NAME, KNOWLEDGE_DIR_NAME, ARCHITECT_PLANS_DIR, filename);
}

/**
 * Атомарно записать `plan.md` в kb и сохранить ссылку в `meta.planPath`.
 * Возвращает обновлённую RunMeta (для broadcast'а) и итоговый
 * workspace-relative путь. Параллель [writeBrief](#L567): один вызов
 * на финализации роли, обновление меты — здесь же.
 */
export async function writePlan(
  runId: string,
  title: string,
  content: string
): Promise<{ run: RunMeta | undefined; planPath: string }> {
  const relPath = buildPlanRelativePath(runId, title);
  const absPath = path.join(getWorkspaceRoot(), relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, absPath);

  const run = await readMeta(runId);
  if (!run) return { run: undefined, planPath: relPath };
  const updated: RunMeta = {
    ...run,
    planPath: relPath,
    updatedAt: new Date().toISOString(),
  };
  await writeMeta(updated);
  return { run: updated, planPath: relPath };
}

/** Прочитать `plan.md` рана. Undefined — `meta.planPath` пуст или файл исчез. */
export async function readPlan(runId: string): Promise<string | undefined> {
  const meta = await readMeta(runId);
  if (!meta?.planPath) return undefined;
  const absPath = path.join(getWorkspaceRoot(), meta.planPath);
  try {
    return await fs.readFile(absPath, 'utf8');
  } catch {
    return undefined;
  }
}

/* ── Summary (per-run, stored in shared kb) ─────────────────────── */

/**
 * Параллель `buildBriefRelativePath`/`buildPlanRelativePath` для
 * программиста (#0027): `summary.md` лежит в
 * `.agents/knowledge/programmer/summaries/<runId>-<slug>.md`.
 */
function buildSummaryRelativePath(runId: string, title: string): string {
  const filename = `${runId}-${slugifyTitle(title)}.md`;
  return path.join(ROOT_DIR_NAME, KNOWLEDGE_DIR_NAME, PROGRAMMER_SUMMARIES_DIR, filename);
}

/**
 * Атомарно записать `summary.md` в kb и сохранить ссылку в
 * `meta.summaryPath`. Возвращает обновлённую RunMeta (для broadcast'а)
 * и итоговый workspace-relative путь. Параллель [writeBrief](#L567)
 * и [writePlan](#L660): один вызов на финализации программиста.
 */
export async function writeSummary(
  runId: string,
  title: string,
  content: string
): Promise<{ run: RunMeta | undefined; summaryPath: string }> {
  const relPath = buildSummaryRelativePath(runId, title);
  const absPath = path.join(getWorkspaceRoot(), relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, absPath);

  const run = await readMeta(runId);
  if (!run) return { run: undefined, summaryPath: relPath };
  const updated: RunMeta = {
    ...run,
    summaryPath: relPath,
    updatedAt: new Date().toISOString(),
  };
  await writeMeta(updated);
  return { run: updated, summaryPath: relPath };
}

/** Прочитать `summary.md` рана. Undefined — `meta.summaryPath` пуст или файл исчез. */
export async function readSummary(runId: string): Promise<string | undefined> {
  const meta = await readMeta(runId);
  if (!meta?.summaryPath) return undefined;
  const absPath = path.join(getWorkspaceRoot(), meta.summaryPath);
  try {
    return await fs.readFile(absPath, 'utf8');
  } catch {
    return undefined;
  }
}

/* ── Chat (per-session) ─────────────────────────────────────────── */

/**
 * Дописать сообщение в `chat.jsonl` активной сессии рана. Формат —
 * по строке на сообщение (append-only, дешёвый парсинг).
 *
 * Если нужно писать в конкретную сессию (не активную) — передай
 * sessionId явно. На Phase 1 такой кейс есть только в тестах.
 */
export async function appendChatMessage(
  runId: string,
  message: ChatMessage,
  sessionId?: string
): Promise<string> {
  const sid = sessionId ?? (await getActiveSessionIdOrThrow(runId));
  const filePath = path.join(getSessionDir(runId, sid), CHAT_FILE);
  await fs.appendFile(filePath, JSON.stringify(message) + '\n', 'utf8');
  return sid;
}

/**
 * Прочитать всю историю чата активной сессии. Игнорирует пустые строки
 * и битые JSON-записи — лучше показать частичную историю, чем уронить UI.
 */
export async function readChat(runId: string, sessionId?: string): Promise<ChatMessage[]> {
  const sid = sessionId ?? (await readMeta(runId).then((m) => m?.activeSessionId));
  if (!sid) return [];
  const filePath = path.join(getSessionDir(runId, sid), CHAT_FILE);
  return readJsonl<ChatMessage>(filePath);
}

/* ── Tool events (per-session) ──────────────────────────────────── */

/**
 * Запись tool-события: один шаг agent-loop'а. Append-only лог в
 * `tools.jsonl`. Дискриминированный union по `kind` — легко расширять
 * новыми типами событий.
 *
 * `assistant`-вариант несёт опциональный `usage` — стоимость и токены
 * этого конкретного шага модели. Заполняется в `runAgentLoop` после
 * получения ответа OpenRouter; per-step разбивка нужна UI, чтобы
 * показывать стоимость каждого шага в ленте.
 */
export type ToolEvent =
  | {
      kind: 'assistant';
      at: string;
      content: string | null;
      tool_calls?: Array<{ id: string; name: string; arguments: string }>;
      /**
       * Usage этого assistant-ответа. Опциональный, потому что у старых
       * (до #0008) логов поля нет, и мы не должны падать при их чтении.
       * Новые шаги цикла всегда заполняют, если OpenRouter вернул usage.
       */
      usage?: {
        model: string;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        /** Стоимость в USD; null = модель без зафиксированного тарифа. */
        costUsd: number | null;
      };
    }
  | {
      kind: 'tool_result';
      at: string;
      tool_call_id: string;
      tool_name: string;
      result?: unknown;
      error?: string;
    }
  | {
      kind: 'system';
      at: string;
      message: string;
    }
  | {
      /**
       * Системная запись о том, что роль присоединена к сессии-комнате
       * (#0036). Пишется ровно одним вызовом `pullIntoRoom` при реальном
       * добавлении (если роль уже есть — событие не дублируется).
       *
       * Хранится в `tools.jsonl`, а не в `chat.jsonl`, потому что это
       * системная запись и должна рендериться отдельным стилем (журнал
       * встреч #0046), а не как сообщение пользователя/агента.
       */
      kind: 'participant_joined';
      at: string;
      /** Какая агентская роль присоединилась — `architect`, `programmer`, … */
      role: string;
    };

/** Дописать одно tool-событие в `tools.jsonl` активной сессии (или указанной). */
export async function appendToolEvent(
  runId: string,
  event: ToolEvent,
  sessionId?: string
): Promise<string> {
  const sid = sessionId ?? (await getActiveSessionIdOrThrow(runId));
  const filePath = path.join(getSessionDir(runId, sid), TOOLS_FILE);
  await fs.appendFile(filePath, JSON.stringify(event) + '\n', 'utf8');
  return sid;
}

/**
 * Прочитать все tool-события активной сессии. Битые строки пропускаем,
 * как в `readChat`.
 */
export async function readToolEvents(runId: string, sessionId?: string): Promise<ToolEvent[]> {
  const sid = sessionId ?? (await readMeta(runId).then((m) => m?.activeSessionId));
  if (!sid) return [];
  const filePath = path.join(getSessionDir(runId, sid), TOOLS_FILE);
  return readJsonl<ToolEvent>(filePath);
}

/* ── Pending ask_user ───────────────────────────────────────────── */

export interface PendingAsk {
  toolCallId: string;
  question: string;
  context?: string;
  at: string;
}

/**
 * Найти последний неотвеченный `ask_user` в `tools.jsonl` активной
 * сессии (или указанной). Используется и для resume после перезапуска
 * VS Code, и для отрисовки вопроса в UI при выборе рана.
 *
 * Алгоритм: сначала собираем set tool_call_id'шек с уже пришедшими
 * результатами, затем идём с конца и ищем самый поздний `ask_user`-вызов
 * без результата.
 */
export async function findPendingAsk(
  runId: string,
  sessionId?: string
): Promise<PendingAsk | undefined> {
  const events = await readToolEvents(runId, sessionId);
  const answered = new Set<string>();
  for (const ev of events) {
    if (ev.kind === 'tool_result') answered.add(ev.tool_call_id);
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind !== 'assistant' || !ev.tool_calls) continue;
    for (const call of ev.tool_calls) {
      if (call.name !== 'ask_user') continue;
      if (answered.has(call.id)) continue;
      let parsed: { question?: string; context?: string } = {};
      try {
        parsed = JSON.parse(call.arguments) as typeof parsed;
      } catch {
        // битый JSON — UI покажет пустой вопрос, не падая
      }
      return {
        toolCallId: call.id,
        question: parsed.question ?? '(пустой вопрос)',
        context: parsed.context,
        at: ev.at,
      };
    }
  }
  return undefined;
}

/* ── Usage accumulation ─────────────────────────────────────────── */

/**
 * Один шаг usage от OpenRouter. Пишется в SessionMeta.usage и
 * прокидывается в RunMeta.usage через `persistSessionUpdate`.
 */
export interface UsageStep {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
}

/**
 * Накопить usage в активной сессии. Возвращает обновлённую RunMeta
 * (для broadcast'а) и обновлённый SessionMeta (если кто-то хочет
 * показать новый per-session aggregate сразу).
 *
 * Логика «costUsd: null»: если у этого шага `null` — суммарный costUsd
 * сессии тоже становится `null` (правило «один неизвестный тариф ⇒ итог
 * неизвестен»). Это критично для TC-27 в #0008: модель без тарифа не
 * должна молча показывать $0.
 */
export async function addUsageToActiveSession(
  runId: string,
  step: UsageStep
): Promise<{ run: RunMeta | undefined; session: SessionMeta | undefined }> {
  const sid = await getActiveSessionIdOrThrow(runId).catch(() => undefined);
  if (!sid) return { run: undefined, session: undefined };
  const session = await readSessionMeta(runId, sid);
  if (!session) return { run: undefined, session: undefined };

  const prev = session.usage;
  const cost: number | null =
    prev.costUsd === null || step.costUsd === null ? null : prev.costUsd + step.costUsd;

  const updated: SessionMeta = {
    ...session,
    usage: {
      inputTokens: prev.inputTokens + step.promptTokens,
      outputTokens: prev.outputTokens + step.completionTokens,
      costUsd: cost,
      lastTotalTokens: step.totalTokens,
      lastModel: step.model,
    },
    updatedAt: new Date().toISOString(),
  };
  const run = await persistSessionUpdate(runId, updated);
  return { run, session: updated };
}

/* ── jsonl reader ───────────────────────────────────────────────── */

async function readJsonl<T>(filePath: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const out: T[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // битая строка — пропускаем
    }
  }
  return out;
}
