import pkg from "../../package.json" with { type: "json" };

/** Who asks, on every request the web tools make: the program, its version and a place to read about it (the form Wikimedia and other sites ask for; no person's address is in it). */
export const USER_AGENT = `navvied/${pkg.version} (https://navvied.com)`;
