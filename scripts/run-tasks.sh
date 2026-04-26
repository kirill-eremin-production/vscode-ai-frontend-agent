#!/usr/bin/env bash
# Прогон задач #0033..#0052 в headless Claude Code.
# Каждая задача = 2 итерации: implement → review. После каждой — отдельный коммит.
# Протокол — в AUTONOMOUS-WORKFLOW.md (агент читает его сам).
#
# Использование:
#   ./scripts/run-tasks.sh                  # весь список
#   ./scripts/run-tasks.sh 0040 0041        # только указанные
#   START=0045 ./scripts/run-tasks.sh       # с задачи 0045 до конца
#   STOP_ON_NO_COMMIT=0 ./scripts/run-tasks.sh   # не падать, если фаза не сделала коммит
#
# Требует:
#   - claude (Claude Code CLI) в PATH
#   - чистый рабочий tree перед стартом (или хотя бы без конфликтов)
#   - mainline ветка main (мы её не переключаем)
#
# Конфигурация модели (зафиксирована ниже):
#   - модель: claude-opus-4-7 (полное имя, не алиас — пин на 4.7)
#   - context window: 200k. На Max/Team/Enterprise планах Opus 4.7 по умолчанию
#     апгрейдится до 1M; per-run пина вниз нет, отключаем глобально на время
#     прогона через CLAUDE_CODE_DISABLE_1M_CONTEXT=1 (export ниже).
#   - auto-compaction: дефолт-on в headless mode
#   - reasoning effort: medium (доступно low/medium/high/xhigh/max)

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

ALL_TASKS=(
  0033 0034 0035 0036 0037 0038 0039 0040 0041 0042
  0043 0044 0045 0046 0047 0048 0049 0050 0051 0052
)

# --- выбор подмножества задач ---
if [[ $# -gt 0 ]]; then
  TASKS=("$@")
else
  TASKS=("${ALL_TASKS[@]}")
fi

if [[ -n "${START:-}" ]]; then
  FILTERED=()
  STARTED=0
  for t in "${TASKS[@]}"; do
    if [[ "$t" == "$START" ]]; then STARTED=1; fi
    if [[ "$STARTED" == "1" ]]; then FILTERED+=("$t"); fi
  done
  TASKS=("${FILTERED[@]}")
fi

STOP_ON_NO_COMMIT="${STOP_ON_NO_COMMIT:-1}"

# --- безопасность ---
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "[fatal] текущая ветка '$BRANCH', а не main. Переключись и запусти заново." >&2
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "[fatal] не нашёл 'claude' в PATH" >&2
  exit 1
fi

LOG_DIR="$REPO_ROOT/.autorun-logs"
mkdir -p "$LOG_DIR"

# Срезаем 1M-вариант контекста на время прогона: даунгрейд per-run в CLI не
# поддержан, а нам нужен предсказуемый 200k бюджет (auto-compaction вместо
# распухания контекста). Export локальный — на дочерние процессы claude.
export CLAUDE_CODE_DISABLE_1M_CONTEXT=1

# Флаги, общие для всех вызовов claude. Меняй здесь — применится ко всем фазам.
CLAUDE_FLAGS=(
  --model claude-opus-4-7
  --effort medium
  --dangerously-skip-permissions
)

run_phase() {
  local task="$1" phase="$2"
  local before after log
  log="$LOG_DIR/${task}-${phase}.log"
  before="$(git rev-parse HEAD)"

  local prompt
  if [[ "$phase" == "implement" ]]; then
    prompt="Ты работаешь в автономном режиме. Прочитай AUTONOMOUS-WORKFLOW.md и AGENT.md.

Задача: #${task}. Фаза: implement.

Найди файл issues/${task}-*.md, прочитай целиком. Выполни AC по протоколу (код + unit-тесты + user story + e2e TC). Прогони lint+build+test:unit, добейся зелёного, сделай ОДИН коммит по формату из AUTONOMOUS-WORKFLOW.md фаза 1 шаг 7.

Не задавай вопросов. Не пуш. Не переключай ветки. Не переименовывай задачу в DONE — это фаза review.

Когда коммит создан — выходи."
  else
    prompt="Ты работаешь в автономном режиме. Прочитай AUTONOMOUS-WORKFLOW.md и AGENT.md.

Задача: #${task}. Фаза: review.

Прочитай issues/${task}-*.md заново. Запусти 'git show HEAD' и сверь с AC построчно. Доработай что упустили (тесты, US, TC, комментарии, lint). Закрой задачу: status=done, секция Outcome, git mv в DONE-. Сделай минимум один коммит (review и/или done). Если ревью без замечаний — комбинируй с закрытием в один done-коммит.

Не задавай вопросов. Не пуш. Не переключай ветки.

Когда задача переименована в DONE- и закоммичена — выходи."
  fi

  echo "==> #${task} [${phase}]  (log: ${log})"

  # CLAUDE_FLAGS определены выше (модель, effort, permissions).
  # Если нужно подтверждать каждое действие — замени --dangerously-skip-permissions
  # на --permission-mode acceptEdits в массиве CLAUDE_FLAGS.
  if ! claude -p "$prompt" "${CLAUDE_FLAGS[@]}" > "$log" 2>&1; then
    echo "[warn] claude вышел с ошибкой на #${task} ${phase}. См. $log"
  fi

  after="$(git rev-parse HEAD)"
  if [[ "$before" == "$after" ]]; then
    echo "[no-commit] #${task} ${phase}: коммита не появилось"
    if [[ "$STOP_ON_NO_COMMIT" == "1" ]]; then
      echo "[fatal] прерываюсь. Разберись с #${task} вручную и запусти заново со START=${task}." >&2
      exit 2
    fi
  else
    git --no-pager log -1 --oneline "$after"
  fi
}

is_done() {
  local task="$1"
  ls "$REPO_ROOT/issues/DONE-${task}-"*.md >/dev/null 2>&1
}

for task in "${TASKS[@]}"; do
  if is_done "$task"; then
    echo "==> #${task} уже DONE — пропускаю"
    continue
  fi
  run_phase "$task" implement
  run_phase "$task" review
  echo "==> #${task} ✓ закрыта"
  echo
done

echo "Все задачи из списка обработаны."
