import { getUser } from "./users.ts";

export function greet(id: number): string {
  return `Hello, ${getUser(id).name}!`;
}
