/**
 * Публичный API роли программиста (issue #0027). Снаружи импортируем
 * только эти имена; внутренности (workspace fs тулы, finalize) скрыты.
 */
export { runProgrammer, registerProgrammerResumer } from './run';
