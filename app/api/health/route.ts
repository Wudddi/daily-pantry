import { actorFrom, json, boundedJson, requireSameOrigin } from '@/lib/inventory-store';
import { readHealth, mutateHealth, safeHealthState, healthErrorResponse } from '@/lib/health-store';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try { return json(safeHealthState(await readHealth(actorFrom(request)))); }
  catch (error) { return healthErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const actor = actorFrom(request);
    requireSameOrigin(request);
    return json(safeHealthState(await mutateHealth(actor, await boundedJson(request))));
  } catch (error) { return healthErrorResponse(error); }
}
