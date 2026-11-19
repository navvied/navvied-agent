import { fetchUser } from "./users.ts";

export function greet(id: number): string {
  return `Hello, ${fetchUser(id).name}!`;
}
