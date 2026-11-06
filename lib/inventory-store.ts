import { env } from 'cloudflare:workers';
import { seedState, applyMutation } from './inventory.mjs';

export class InventoryError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'invalid_request') {
    super(message); this.status = status; this.code = code;
  }
}

export function actorFrom(request: Request) {
  const actor = request.headers.get('oai-authenticated-user-id');
  if (!actor || actor.length > 256) throw new InventoryError("Sign in before reading or updating your inventory.", 401, 'sign_in_required');
  return actor;
}

function bucket() {
  const value = (env as Cloudflare.Env).BUCKET;
  if (!value) throw new InventoryError("Inventory storage is temporarily unavailable. Refresh later.", 503, 'storage_unavailable');
  return value;
}

function keyFor(actor: string) { return `inventory/v1/${encodeURIComponent(actor)}.json`; }

export async function readInventory(actor: string) {
  const object = await bucket().get(keyFor(actor));
  if (!object) return { state: seedState(), etag: null as string | null };
  const state = await object.json<ReturnType<typeof seedState>>();
  if (state.schemaVersion !== 1 || !Array.isArray(state.items) || !Array.isArray(state.events)) {
    throw new InventoryError("The inventory file has an invalid format. Original data was preserved. Try again later.", 503, 'invalid_stored_state');
  }
  return { state, etag: object.etag };
}

export async function mutateInventory(actor: string, payload: unknown) {
  const current = await readInventory(actor);
  const next = applyMutation(current.state, payload);
  if (next === current.state || next.revision === current.state.revision) return current;
  const saved = await bucket().put(keyFor(actor), JSON.stringify(next), {
    onlyIf: current.etag ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
  });
  if (!saved) throw new InventoryError("Inventory changed elsewhere. Refresh before continuing; this edit was not applied twice.", 409, 'revision_conflict');
  return { state: next, etag: saved.etag };
}

export function safeState(result: Awaited<ReturnType<typeof readInventory>>) {
  const { operationIds: _operationIds, ...state } = result.state;
  return { state, etag: result.etag };
}

export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Cookie' } });
}

export function errorResponse(error: unknown) {
  const value = error as { status?: number; message?: string; code?: string };
  const status = value.status && value.status >= 400 && value.status <= 599 ? value.status : 503;
  return json({ error: status === 503 ? "The inventory service is temporarily unavailable. Existing data will not be cleared. Try again later." : value.message || "This operation was not completed.", code: value.code || 'service_error' }, status);
}

export async function boundedJson(request: Request) {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new InventoryError("Send data in JSON format.", 415);
  if (Number(request.headers.get('content-length') || 0) > 512000) throw new InventoryError("This data is too large. Reduce the number of entries in one import.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new InventoryError("No data was received to save.");
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 512000) { await reader.cancel(); throw new InventoryError("This data is too large. Reduce the number of entries in one import.", 413); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new InventoryError("The data format could not be read. Check the import file."); }
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new InventoryError("Update data from the inventory page.", 403, 'origin_mismatch');
  }
}
