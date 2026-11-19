export async function fetchOne(id: number): Promise<{ id: number; name: string }> {
  return { id, name: `item-${id}` };
}

export async function loadAll(ids: number[]): Promise<{ id: number; name: string }[]> {
  return Promise.all(ids.map((id) => fetchOne(id)));
}
