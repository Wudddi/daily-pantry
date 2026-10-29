/** A date-bound, serial writer. Only successful server receipts advance revision. */
export function createSupplementCheckQueue({ date, revision, confirmed = {}, send, onChange = () => {} }) {
  let server = { ...confirmed }, pending = [], active = null, failed = [], blocked = false, detached = false, error = '';
  let currentRevision = revision;
  const snapshot = () => {
    const checked = { ...server };
    for (const entry of [active, ...pending]) if (entry) checked[entry.doseId] = entry.checked;
    return { checked, pendingDoseIds: [...new Set([active, ...pending].filter(Boolean).map(entry => entry.doseId))], pendingCount: (active ? 1 : 0) + pending.length, failedDoseIds: [...new Set(failed.map(entry => entry.doseId))], blocked, error, revision: currentRevision };
  };
  const emit = () => { if (!detached) onChange(snapshot()); };

  async function drain() {
    if (active || blocked) return;
    while (pending.length && !blocked) {
      active = pending.shift();
      emit();
      const entry = active;
      try {
        const result = await send({ date, doseId: entry.doseId, checked: entry.checked, expectedRevision: currentRevision });
        if (!result?.ok || !Number.isSafeInteger(result.revision) || result.revision < currentRevision) throw new Error('未确认保存成功。');
        currentRevision = result.revision;
        server[entry.doseId] = entry.checked;
        active = null;
        // An undo followed by another check can collapse to the receipt just saved.
        pending = pending.filter(next => next.doseId !== entry.doseId || next.checked !== server[entry.doseId]);
        emit();
      } catch (cause) {
        // Roll every unsaved optimistic mark back; keep intentions for explicit retry.
        failed = [entry, ...pending];
        pending = [];
        active = null;
        blocked = true;
        error = cause instanceof Error ? cause.message : '未确认保存成功。';
        emit();
      }
    }
  }

  return {
    snapshot,
    set(doseId, checked) {
      if (detached || blocked || typeof checked !== 'boolean' || !Object.hasOwn(server, doseId)) return false;
      // Keep only the latest unsent intention for this dose. Never alter an in-flight request.
      pending = pending.filter(entry => entry.doseId !== doseId);
      const preceding = active?.doseId === doseId ? active.checked : server[doseId];
      if (checked !== preceding) pending.push({ doseId, checked });
      emit();
      void drain();
      return true;
    },
    sync(nextRevision, nextConfirmed) {
      if (detached || blocked || active || pending.length || nextRevision < currentRevision) return;
      currentRevision = nextRevision;
      server = { ...nextConfirmed };
      emit();
    },
    retry() {
      if (detached || !blocked) return;
      blocked = false;
      error = '';
      const final = new Map();
      for (const entry of failed) final.set(entry.doseId, entry);
      // A failed response may follow a committed write: explicitly send even a
      // final value equal to our old baseline, rather than assume it was not saved.
      pending = [...final.values()];
      failed = [];
      emit();
      void drain();
    },
    dispose() {
      // A date switch detaches the view, not the user's already queued writes.
      detached = true;
    },
  };
}
