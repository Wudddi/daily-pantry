export type UiLanguage = 'zh-CN' | 'en';
export function getUiLanguage(): UiLanguage;
export function uiLocale(): 'zh-CN' | 'en-CA';
export function uiText<T extends string | undefined | null>(text: T, context?: string): T extends string ? string : T;
