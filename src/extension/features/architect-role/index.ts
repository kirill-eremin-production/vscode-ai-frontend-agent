/**
 * Публичный API роли архитектора. Снаружи импортируем только эти
 * имена; внутренности (resumer, finalize) скрыты.
 */
export { runArchitect, registerArchitectResumer } from './run';
