export async function fetchOne(id: number): Promise<{ id: number; name: string }> {
  return { id, name: `item-${id}` };
}

export async function loadAll(ids: number[]): Promise<{ id: number; name: string }[]> {
  return ids.map((id) => fetchOne(id)) as unknown as { id: number; name: string }[];
}
