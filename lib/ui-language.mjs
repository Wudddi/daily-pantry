import config from './ui-language-config.json' with { type: 'json' };
import chinese from './ui-zh-CN.json' with { type: 'json' };

/** Build-time product language; a Node-only override isolates test processes. */
export function getUiLanguage() {
  const override = typeof process !== 'undefined' && process.versions?.node
    ? process.env?.PANTRY_UI_LANGUAGE : undefined;
  const language = override ?? config.language;
  return language === 'zh-CN' || language === 'zh' ? 'zh-CN' : 'en';
}
export function uiLocale() { return getUiLanguage() === 'zh-CN' ? 'zh-CN' : 'en-CA'; }

/** Localize authored interface copy only. Never pass user-entered records here. */
export function uiText(text, context = '') {
  if (typeof text !== 'string' || getUiLanguage() !== 'zh-CN') return text;
  if (!/[A-Za-z0-9]/.test(text)) return text;
  const contextual = context + '\u0004' + text;
  if (context && Object.hasOwn(chinese, contextual)) return chinese[contextual];
  if (Object.hasOwn(chinese, text)) return chinese[text];
  const trimmed = text.trim();
  if (!trimmed || !Object.hasOwn(chinese, trimmed)) return text;
  const start = text.indexOf(trimmed);
  return text.slice(0, start) + chinese[trimmed] + text.slice(start + trimmed.length);
}
