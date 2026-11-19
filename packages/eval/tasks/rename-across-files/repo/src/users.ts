export function getUser(id: number): { id: number; name: string } {
  return { id, name: `user-${id}` };
}
