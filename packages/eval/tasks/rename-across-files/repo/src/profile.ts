import { getUser } from "./users.ts";

export const profileLine = (id: number): string => `#${getUser(id).id} ${getUser(id).name}`;
