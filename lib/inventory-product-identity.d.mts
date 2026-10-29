export type ProductIdentity = {
  id?: string; name?: string; aliases?: string[]; brand?: string; category?: string; unit?: string;
  status?: string; gramsPerUnit?: number | null;
  nutrition?: { source?: string; nutrientSources?: Partial<Record<string, string>> };
};
export function isReusableProduct(item: ProductIdentity | null | undefined): boolean;
export function matchExistingProducts<T extends ProductIdentity>(items: T[], candidate: ProductIdentity): T[];
