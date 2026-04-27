/**
 * Хранилище meeting-request'ов рана (#0049).
 *
 * Meeting-request — это «заявка одной роли на встречу с другой»: продакт
 * хочет позвать архитектора (и наоборот). Сущность переживает рестарт VS
 * Code, поэтому лежит на диске рядом с другими артефактами рана:
 *
 *   .agents/runs/<runId>/meeting-requests.jsonl
 *
 * Формат — append-only JSONL, по строке на событие. Поддерживаем два
 * вида строк (дискриминированный union по `kind`):
 *
 *  - `{ kind: 'created', request: MeetingRequest }` — новая заявка.
 *    Запись добавляется ровно один раз, сразу со статусом `pending`.
 *  - `{ kind: 'status', id, status, resolvedAt?, resolvedSessionId?,
 *    failureReason? }` — обновление статуса по id. Появляется столько
 *    раз, сколько было переходов; «последний выигрывает» при чтении.
 *
 * Append-only выбран намеренно: запись в журнале (#0046) опирается на
 * порядок появления, а откат состояния через перезапись JSON чувствителен
 * к гонкам «два шага agent-loop'а пишут одновременно». Файл крошечный
 * (мало запросов на ран), поэтому folding в памяти при чтении достаточен —
 * никаких индексов на диске не строим (см. issue Implementation notes).
 *
 * Логика «когда создавать», «когда резолвить» — НЕ здесь, а в
 * #0050/#0051 (resolver и tools). Этот модуль — чистое хранилище.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import type { Role } from '../../team/hierarchy';
import { getRunDir } from './storage';

/** Имя файла-журнала запросов в каталоге рана. */
const MEETING_REQUESTS_FILE = 'meeting-requests.jsonl';

/**
 * Возможные состояния meeting-request'а.
 *
 *  - `pending` — создан, координатор ещё не привёл его к комнате.
 *  - `resolved` — встреча состоялась: создана/найдена комната
 *    (`resolvedSessionId`), туда отправлено `message` инициатора.
 *  - `failed` — резолв невозможен (например, пользователь отменил
 *    эскалацию, или условия #0031 не выполнились); причина в
 *    `failureReason`.
 */
export type MeetingRequestStatus = 'pending' | 'resolved' | 'failed';

/**
 * Полная заявка на встречу. На диск пишется один раз в `created`-строке;
 * последующие изменения статуса накладываются `status`-строками.
 *
 * Поле `id` генерируется в {@link createMeetingRequest} (формат `mr_xxxx`,
 * аналогично `s_xxxx` для сессий — отличается префиксом, чтобы в логах
 * id-шки не путались с сессионными).
 *
 * `contextSessionId` — сессия, *из которой* инициатор (`requesterRole`)
 * сделал запрос. Это нужно резолверу (#0050), чтобы понять контекст:
 * заявка из bridge'а, hybrid'а или комнаты.
 *
 * `message` — стартовое сообщение, которое уйдёт в созданную/найденную
 * комнату от лица инициатора. Сохраняем здесь, потому что между моментом
 * запроса и резолвом может пройти время (роль-получатель занята), а
 * сообщение должно дойти ровно тем текстом, который написал инициатор.
 *
 * `resolvedAt`/`resolvedSessionId`/`failureReason` — заполняются только
 * после соответствующего перехода статуса. До этого — undefined.
 */
export interface MeetingRequest {
  id: string;
  requesterRole: Role;
  requesteeRole: Role;
  /** Сессия инициатора, из которой возник запрос. */
  contextSessionId: string;
  /** Первое сообщение, которое уйдёт в созданную комнату. */
  message: string;
  /** ISO-таймстамп создания. */
  createdAt: string;
  status: MeetingRequestStatus;
  /** ISO-таймстамп резолва (только при `resolved`/`failed`). */
  resolvedAt?: string;
  /** Куда резолвнулось — id сессии-комнаты (только при `resolved`). */
  resolvedSessionId?: string;
  /** Описание причины при `failed`. */
  failureReason?: string;
}

/**
 * Дополнительные поля при обновлении статуса. По форме повторяют
 * соответствующие опциональные поля {@link MeetingRequest} — резолвер
 * (#0050) сам решит, какие из них релевантны конкретному переходу.
 *
 * `resolvedAt` опционален: если не передан и статус ≠ `pending` —
 * проставляется автоматически текущим временем. Это упрощает вызовы
 * на стороне resolver'а (не надо тащить `now()` в каждый call-site).
 */
export interface MeetingRequestStatusUpdate {
  resolvedAt?: string;
  resolvedSessionId?: string;
  failureReason?: string;
}

/* ── Внутренний формат строки журнала ────────────────────────────── */

/**
 * Строка-«создан»: единственный place, где записываются базовые поля
 * запроса (id, роли, message, createdAt). После неё в журнал летят
 * только `status`-строки.
 */
interface CreatedEntry {
  kind: 'created';
  request: MeetingRequest;
}

/**
 * Строка-«обновление статуса». Хранит ровно дельту: id + новый статус +
 * опциональные resolvedAt/resolvedSessionId/failureReason. Никаких
 * полей запроса (они уже в `created`-строке) — это и есть смысл
 * append-only журнала: дельты, а не снэпшоты.
 */
interface StatusEntry {
  kind: 'status';
  id: string;
  status: MeetingRequestStatus;
  resolvedAt?: string;
  resolvedSessionId?: string;
  failureReason?: string;
}

type LogEntry = CreatedEntry | StatusEntry;

/* ── Path helper ─────────────────────────────────────────────────── */

function getMeetingRequestsPath(runId: string): string {
  return path.join(getRunDir(runId), MEETING_REQUESTS_FILE);
}

/* ── Id generator ────────────────────────────────────────────────── */

/**
 * Сгенерировать id новой заявки. Префикс `mr_` (meeting request) выбран
 * по аналогии с `s_` для сессий: в логах сразу видно, что за объект.
 * 4 байта random hex дают 8 hex-символов — на ран таких заявок единицы,
 * коллизии практически невозможны.
 */
function generateRequestId(): string {
  return `mr_${crypto.randomBytes(4).toString('hex')}`;
}

/* ── Append helpers ──────────────────────────────────────────────── */

/**
 * Дописать одну строку в журнал запросов рана. Создаёт каталог рана,
 * если его ещё нет (`recursive: true`). На практике каталог уже
 * существует — ран инициализируется через `initRunDir` до первой
 * заявки, но проверка дешёвая, а защита от race условий полезна.
 */
async function appendEntry(runId: string, entry: LogEntry): Promise<void> {
  const filePath = getMeetingRequestsPath(runId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
}

/* ── Public API ──────────────────────────────────────────────────── */

/**
 * Параметры новой заявки. Без `id`/`createdAt`/`status` —
 * хранилище проставляет их само (id — рандом, createdAt — текущее
 * время, status — всегда `pending` на момент создания).
 */
export interface CreateMeetingRequestInput {
  requesterRole: Role;
  requesteeRole: Role;
  contextSessionId: string;
  message: string;
}

/**
 * Создать новую заявку: присваивает id, фиксирует createdAt и записывает
 * `created`-строку в журнал. Возвращает уже заполненную {@link MeetingRequest}
 * (status=`pending`), чтобы вызывающий код мог сразу её использовать без
 * повторного `listMeetingRequests`.
 *
 * Бросает `RunStorageError` транзитивно через {@link getRunDir}, если
 * нет открытого workspace — тот же контракт, что у остальных операций
 * хранилища.
 */
export async function createMeetingRequest(
  runId: string,
  input: CreateMeetingRequestInput
): Promise<MeetingRequest> {
  const request: MeetingRequest = {
    id: generateRequestId(),
    requesterRole: input.requesterRole,
    requesteeRole: input.requesteeRole,
    contextSessionId: input.contextSessionId,
    message: input.message,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  await appendEntry(runId, { kind: 'created', request });
  return request;
}

/**
 * Обновить статус существующей заявки. Append `status`-строки —
 * никаких прочитать-смерджить-перезаписать. При статусах `resolved`
 * и `failed` подставляет `resolvedAt = now`, если вызывающий код его
 * не передал явно (см. {@link MeetingRequestStatusUpdate}).
 *
 * Идемпотентность не гарантируется: повторный вызов запишет ещё одну
 * строку. Так и задумано: каждый переход — это событие со своим
 * временем, а не идемпотентное «привести к состоянию». Если нужна
 * идемпотентность — её делает вызывающий код (resolver в #0050).
 *
 * Не бросает, если запроса с таким id нет: журнал append-only, проверка
 * существования потребовала бы предварительного fold'а и race-а с
 * другими писателями. Folding в `listMeetingRequests` отбросит
 * «осиротевшие» status-строки (нет соответствующего created — нет
 * результата в выходе списка).
 */
export async function updateMeetingRequestStatus(
  runId: string,
  id: string,
  status: MeetingRequestStatus,
  extra: MeetingRequestStatusUpdate = {}
): Promise<void> {
  const resolvedAt =
    extra.resolvedAt ?? (status === 'pending' ? undefined : new Date().toISOString());
  const entry: StatusEntry = {
    kind: 'status',
    id,
    status,
    resolvedAt,
    resolvedSessionId: extra.resolvedSessionId,
    failureReason: extra.failureReason,
  };
  await appendEntry(runId, entry);
}

/**
 * Прочитать все заявки рана и применить накопившиеся обновления.
 *
 * Алгоритм:
 *  1. Читаем файл построчно. Битые строки (невалидный JSON, не наша
 *     схема) пропускаем — мы предпочтём показать частичный список, а
 *     не упасть на одной испорченной строке (так же поступают
 *     `readChat`/`readToolEvents` в storage.ts).
 *  2. Для `created` — кладём заявку в Map<id, MeetingRequest>.
 *  3. Для `status` — мерджим в существующую (если её нет — игнорируем,
 *     осиротевший update без `created` не образует валидную заявку).
 *  4. Возвращаем массив в порядке появления `created`-строк. Это
 *     соответствует естественному порядку «по времени создания» и
 *     полезно UI журнала встреч (#0046) без дополнительной сортировки.
 */
export async function listMeetingRequests(runId: string): Promise<MeetingRequest[]> {
  const filePath = getMeetingRequestsPath(runId);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  // Порядок появления нужен для возврата (`order`); состояние — для
  // мерджа. Map сохраняет insertion-order, но мы держим порядок
  // отдельным массивом id, чтобы folding `status`-строк не сбивал его.
  const order: string[] = [];
  const byId = new Map<string, MeetingRequest>();

  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let entry: LogEntry;
    try {
      entry = JSON.parse(line) as LogEntry;
    } catch {
      continue;
    }
    if (entry.kind === 'created') {
      const request = entry.request;
      if (!byId.has(request.id)) order.push(request.id);
      // На случай, если по ошибке встретилось два `created` для одного
      // id — берём первый, последующие игнорируем. Альтернатива
      // (перезапись) маскировала бы баг писателя.
      if (!byId.has(request.id)) byId.set(request.id, { ...request });
    } else if (entry.kind === 'status') {
      const existing = byId.get(entry.id);
      if (!existing) continue;
      // Накладываем дельту: status всегда обновляется, опциональные
      // поля — только если новые значения не undefined. Это позволяет
      // частичным апдейтам не затирать ранее проставленный
      // `resolvedSessionId`, если позже придёт `failed` без него
      // (резолвер не обязан продублировать поле, которое не меняется).
      existing.status = entry.status;
      if (entry.resolvedAt !== undefined) existing.resolvedAt = entry.resolvedAt;
      if (entry.resolvedSessionId !== undefined) {
        existing.resolvedSessionId = entry.resolvedSessionId;
      }
      if (entry.failureReason !== undefined) existing.failureReason = entry.failureReason;
    }
  }

  return order.map((id) => byId.get(id)).filter((r): r is MeetingRequest => r !== undefined);
}

/**
 * Заявки в статусе `pending`. Тонкий фильтр над {@link listMeetingRequests} —
 * вынесен отдельной функцией, потому что вызывающий код (resolver,
 * UI inbox в #0052) делает этот срез часто, а инлайнить `.filter` по
 * всему codebase лишний шум.
 */
export async function getPendingRequests(runId: string): Promise<MeetingRequest[]> {
  const all = await listMeetingRequests(runId);
  return all.filter((request) => request.status === 'pending');
}
