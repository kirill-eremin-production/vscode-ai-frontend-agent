import {
  FileText,
  FilePlus,
  List,
  MessageCircleQuestion,
  Search,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/**
 * Маппинг имени инструмента → lucide-иконка для tool-карточек (#0021).
 *
 * Один источник правды: если завтра tool-loop добавит новый kb.*-тул,
 * тут точечная правка, и иконка сразу появится в карточке.
 * Неизвестный инструмент рендерим через `Wrench`-fallback — это лучше,
 * чем «нет иконки», и подсказывает: «карточка валидна, но мы про этот
 * тул ничего особенного не знаем».
 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  'kb.list': List,
  'kb.read': FileText,
  'kb.grep': Search,
  'kb.write': FilePlus,
  ask_user: MessageCircleQuestion,
};

export function toolIconFor(name: string): LucideIcon {
  return TOOL_ICONS[name] ?? Wrench;
}
