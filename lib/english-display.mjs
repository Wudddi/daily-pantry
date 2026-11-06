/** Localized presentation of persisted units/storage. Never change accounting keys. */
import { getUiLanguage, uiText } from './ui-language.mjs';
const units = Object.freeze({
  g: ['g', 'g'], ml: ['mL', 'mL'], mL: ['mL', 'mL'],
  '袋': ['bag', 'bags'], '个': ['item', 'items'], '片': ['piece', 'pieces'],
  '份': ['serving', 'servings'], '包': ['pack', 'packs'], '罐': ['can', 'cans'],
  '条': ['piece', 'pieces'], '粒': ['unit', 'units'], '滴': ['drop', 'drops'],
});
export function unitLabel(unit, quantity = 1) {
  if (getUiLanguage() === 'zh-CN') return unit === 'ml' || unit === 'mL' ? 'mL' : String(unit ?? '');
  const values = units[unit];
  return values ? values[quantity === 1 ? 0 : 1] : String(unit ?? '');
}
export function storageLabel(value) {
  if (getUiLanguage() === 'zh-CN') return value === '' || value == null ? uiText('Not specified') : String(value);
  return ({ '冷冻': 'Frozen', '冷藏': 'Refrigerated', '常温': 'Room temperature', '': 'Not specified' })[value] ?? String(value ?? '');
}
