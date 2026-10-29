import { actorFrom, readInventory, json, errorResponse } from '@/lib/inventory-store';
import { planningSnapshot } from '@/lib/inventory.mjs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { const { state } = await readInventory(actorFrom(request)); return json(planningSnapshot(state)); }
  catch (error) { return errorResponse(error); }
}
