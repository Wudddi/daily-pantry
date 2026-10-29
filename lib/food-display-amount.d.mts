export type FoodDisplayInput = {
  quantity: number | null;
  unit: string;
  displayQuantity?: number | null;
  displayUnit?: string;
  nutritionSnapshot?: { unit?: string; gramsPerUnit?: number | null; nutrition?: { basisUnit?: string } } | null;
  snapshot?: { unit?: string; gramsPerUnit?: number | null; nutrition?: { basisUnit?: string } } | null;
};
export function foodDisplayAmount(line?: Partial<FoodDisplayInput>): { quantity: number | null; unit: string; converted: boolean; text: string };
export function inventoryDisplayAmount(item?: { quantity?: number | null; unit?: string; category?: string; gramsPerUnit?: number | null; nutrition?: { basisUnit?: string } }): ReturnType<typeof foodDisplayAmount>;
