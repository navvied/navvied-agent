import { fetchUser } from "./users.ts";

export const profileLine = (id: number): string => `#${fetchUser(id).id} ${fetchUser(id).name}`;
