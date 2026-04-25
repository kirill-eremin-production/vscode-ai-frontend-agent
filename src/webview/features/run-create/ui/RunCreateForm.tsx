import { useState, type FormEvent } from 'react';
import { createRun, setApiKey } from '@shared/runs/store';

/**
 * Форма создания нового рана.
 *
 * Минималистичная: textarea + две кнопки. Логику отправки
 * делегируем в `@shared/runs/store` — фича отвечает только за UI.
 *
 * Кнопка «Set API key» лежит здесь же, а не в отдельной фиче,
 * потому что это часть пользовательского сценария первого старта:
 * человек открыл расширение, увидел поле ввода, понял, что нужен
 * ключ, ткнул рядом — и вернулся к промпту. Дробить это на две
 * фичи преждевременно.
 */
export function RunCreateForm() {
  // Локальный стейт — только текст текстарии. Список ранов и
  // выбор живут в общем сторе, сюда им не зачем течь.
  const [prompt, setPrompt] = useState('');

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (trimmed.length === 0) return;
    createRun(trimmed);
    // Очищаем поле сразу: extension либо успешно создаст ран
    // (его покажет run-list), либо вернёт ошибку (увидим тост).
    setPrompt('');
  };

  return (
    <form className="run-create" onSubmit={handleSubmit}>
      <textarea
        className="run-create__input"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        rows={4}
        placeholder="Опишите задачу для команды агентов…"
      />
      <div className="run-create__actions">
        <button type="submit" disabled={prompt.trim().length === 0}>
          Start run
        </button>
        <button type="button" onClick={setApiKey}>
          Set API key
        </button>
      </div>
    </form>
  );
}
