import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@shared/ui';
import { cancelNewRun, clearCreateRunError, createRun, useRunsState } from '@shared/runs/store';

/**
 * Форма создания нового рана (#0018), живёт в main-area.
 *
 * Поля:
 *  - Заголовок (необязательно) — single-line. Если пусто, extension
 *    сгенерит заголовок моделью (US-2, существующая логика).
 *  - Запрос — autosize textarea минимум 8 строк, разумный потолок
 *    через max-height + scroll.
 *
 * Состояние формы — локальное (`useState`): по acceptance #0018
 * черновики не нужны, повторное «+ Новый ран» начинается с пустого.
 *
 * Кнопки — primary `Button` из #0016. На время IPC показываем `loading`
 * с подписью «Создаю ран…»; после успеха store сам переключит main-area
 * в `'run-details'`. Если придёт ошибка — оставляем форму открытой и
 * рисуем сообщение с «Повторить».
 */
const TEXTAREA_MIN_HEIGHT_PX = 160;
const TEXTAREA_MAX_HEIGHT_PX = 480;
const TITLE_MAX_LENGTH = 120;

export function NewRunForm() {
  const { createRunPending, createRunError } = useRunsState();
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Autosize: на каждое изменение перерисовываем высоту textarea.
  // Делаем через ref+effect, а не через CSS field-sizing, потому что
  // последний пока работает не во всех Electron'ах.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const next = Math.min(
      Math.max(ta.scrollHeight, TEXTAREA_MIN_HEIGHT_PX),
      TEXTAREA_MAX_HEIGHT_PX
    );
    ta.style.height = `${next}px`;
  }, [prompt]);

  const trimmed = prompt.trim();
  const submitDisabled = trimmed.length === 0 || createRunPending;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitDisabled) return;
    createRun(trimmed, title);
    // Поля НЕ очищаем сразу: если IPC упадёт (нет ключа, сеть и т.п.),
    // пользователь должен иметь возможность повторить тем же текстом
    // (#0018 acceptance: «текст пользователя не теряется»). На успех
    // store переключит main-area, и форма размонтируется — стейт
    // утратится естественным образом.
  };

  return (
    <form
      className="run-create flex flex-col gap-3 p-4 max-w-[720px] mx-auto w-full"
      onSubmit={handleSubmit}
      aria-label="Новый ран"
    >
      <h2 className="text-[13px] font-semibold m-0">Новый ран</h2>

      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Заголовок (необязательно)
        <input
          type="text"
          className="run-create__title h-7 px-2 text-[12px] bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-border rounded-sm focus:outline-none focus:border-border-focus"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (createRunError) clearCreateRunError();
          }}
          maxLength={TITLE_MAX_LENGTH}
          placeholder="Если пусто — сгенерируется автоматически"
          disabled={createRunPending}
        />
      </label>

      <label className="flex flex-col gap-1 text-[11px] text-muted">
        Запрос
        <textarea
          ref={textareaRef}
          className="run-create__input px-2 py-1.5 text-[12px] bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-border rounded-sm focus:outline-none focus:border-border-focus resize-none leading-relaxed"
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            if (createRunError) clearCreateRunError();
          }}
          rows={8}
          style={{ minHeight: TEXTAREA_MIN_HEIGHT_PX }}
          placeholder="Опишите задачу: например, «Свёрстать страницу профиля с табами и редактированием почты»"
          disabled={createRunPending}
        />
      </label>

      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={createRunPending}
          disabled={submitDisabled}
          title={trimmed.length === 0 ? 'Введите запрос, чтобы запустить ран' : undefined}
        >
          {createRunPending ? 'Создаю ран…' : createRunError ? 'Повторить' : 'Запустить'}
        </Button>
        <Button type="button" variant="ghost" onClick={cancelNewRun} disabled={createRunPending}>
          Отмена
        </Button>
      </div>

      {createRunError && (
        <p
          role="alert"
          className="text-[11px] text-[var(--vscode-errorForeground)] leading-snug m-0"
        >
          Не удалось создать ран: {createRunError}
        </p>
      )}
    </form>
  );
}
