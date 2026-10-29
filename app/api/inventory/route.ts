import { actorFrom, readInventory, mutateInventory, safeState, json, boundedJson, requireSameOrigin, errorResponse } from '@/lib/inventory-store';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try { return json(safeState(await readInventory(actorFrom(request)))); }
  catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const actor = actorFrom(request);
    requireSameOrigin(request);
    return json(safeState(await mutateInventory(actor, await boundedJson(request))));
  } catch (error) { return errorResponse(error); }
}
