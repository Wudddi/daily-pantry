/** Personal reminders never become evidence for an AI's meal or stock decisions. */
export function aiFoodReadState(state) {
  const strip = value => {
    if (!value || typeof value !== 'object') return value;
    const { personalFoodChecks: _private, ...safe } = value;
    if (safe.draft && typeof safe.draft === 'object') {
      const { personalFoodChecks: _draftPrivate, ...draft } = safe.draft; safe.draft = draft;
    }
    return safe;
  };
  return { ...state, plans: (state.plans ?? []).map(strip) };
}
