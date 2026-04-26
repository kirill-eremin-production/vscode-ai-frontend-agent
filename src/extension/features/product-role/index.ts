/**
 * Публичный API продактовой роли. Снаружи (из `service.createRun`,
 * `index.activate`) дёргают только эти три имени; внутренности
 * (sandbox-обёртки kb-тулов, finalize-логика) скрыты.
 */
export { runProduct, registerProductResumer } from './run';
