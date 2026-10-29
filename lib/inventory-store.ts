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
  if (!actor || actor.length > 256) throw new InventoryError('请先登录，再读取或更新你的库存。', 401, 'sign_in_required');
  return actor;
}

function bucket() {
  const value = (env as Cloudflare.Env).BUCKET;
  if (!value) throw new InventoryError('库存存储暂时无法连接，请稍后刷新。', 503, 'storage_unavailable');
  return value;
}

function keyFor(actor: string) { return `inventory/v1/${encodeURIComponent(actor)}.json`; }

export async function readInventory(actor: string) {
  const object = await bucket().get(keyFor(actor));
  if (!object) return { state: seedState(), etag: null as string | null };
  const state = await object.json<ReturnType<typeof seedState>>();
  if (state.schemaVersion !== 1 || !Array.isArray(state.items) || !Array.isArray(state.events)) {
    throw new InventoryError('库存文件格式异常，已保留原始数据，请稍后重试。', 503, 'invalid_stored_state');
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
  if (!saved) throw new InventoryError('库存刚刚在另一处更新了。请刷新后再操作，这次修改未重复执行。', 409, 'revision_conflict');
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
  return json({ error: status === 503 ? '库存服务暂时无法连接，原有数据不会被清空。请稍后重试。' : value.message || '这次操作没有完成。', code: value.code || 'service_error' }, status);
}

export async function boundedJson(request: Request) {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new InventoryError('请发送JSON格式的数据。', 415);
  if (Number(request.headers.get('content-length') || 0) > 512000) throw new InventoryError('这份数据太大，请减少单次导入数量。', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new InventoryError('没有收到要保存的数据。');
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 512000) { await reader.cancel(); throw new InventoryError('这份数据太大，请减少单次导入数量。', 413); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new InventoryError('数据格式无法读取。请检查导入文件。'); }
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new InventoryError('请在库存页面中更新数据。', 403, 'origin_mismatch');
  }
}
