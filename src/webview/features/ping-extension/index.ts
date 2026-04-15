/**
 * Публичный API фичи `ping-extension`.
 * По соглашению FSD внешние слои (pages, app) импортируют только
 * то, что реэкспортировано из этого barrel-файла, а во внутреннюю
 * структуру (`ui/`, `model/`) ходить запрещено.
 */
export { PingButton } from './ui/PingButton';
