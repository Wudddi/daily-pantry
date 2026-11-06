import { env } from 'cloudflare:workers';
import { seedHealthState, applyHealthMutation, healthSummary } from './health.mjs';
import { InventoryError, json } from './inventory-store';

function bucket() {
  const value = (env as Cloudflare.Env).BUCKET;
  if (!value) throw new InventoryError("Health record storage is temporarily unavailable. Try again later.", 503, 'health_storage_unavailable');
  return value;
}

function keyFor(actor: string) { return `health/v1/${encodeURIComponent(actor)}.json`; }

export async function readHealth(actor: string) {
  const object = await bucket().get(keyFor(actor));
  if (!object) return { state: seedHealthState(), etag: null as string | null };
  const state = await object.json<ReturnType<typeof seedHealthState>>();
  if (state.schemaVersion !== 1 || !Array.isArray(state.measurements) || !Array.isArray(state.sessions) || !Array.isArray(state.events) || !Array.isArray(state.operationIds)) {
    throw new InventoryError("The health record file has an invalid format. Original data was preserved. Try again later.", 503, 'invalid_health_state');
  }
  return { state, etag: object.etag };
}

export async function mutateHealth(actor: string, payload: unknown) {
  const current = await readHealth(actor);
  const next = applyHealthMutation(current.state, payload);
  if (next === current.state || next.revision === current.state.revision) return current;
  const saved = await bucket().put(keyFor(actor), JSON.stringify(next), {
    onlyIf: current.etag ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
  });
  if (!saved) throw new InventoryError("Health records changed elsewhere. Read them again before continuing; this operation did not create duplicate records.", 409, 'health_revision_conflict');
  return { state: next, etag: saved.etag };
}

export function safeHealthState(result: Awaited<ReturnType<typeof readHealth>>) {
  const { operationIds: _operationIds, ...state } = result.state;
  return { state, summary: healthSummary(result.state), etag: result.etag };
}

export function healthErrorResponse(error: unknown) {
  const value = error as { status?: number; message?: string; code?: string };
  const status = value.status && value.status >= 400 && value.status <= 599 ? value.status : 503;
  return json({ error: status >= 500 ? "The health record service is temporarily unavailable. Existing data will not be cleared. Try again later." : value.message || "This health record was not saved.", code: value.code || 'health_service_error' }, status);
}
