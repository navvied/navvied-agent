/**
 * What git is told by its caller about which repository it works in. A program started by a git hook (the pre-push gate is one) inherits it, and then every
 * `git init` or `git commit` it or its tests run in a folder of their own works on the repository that started the hook instead: the config, the HEAD and
 * the refs of the real one are changed. This is the list git itself gives (`git rev-parse --local-env-vars`).
 */
export const GIT_LOCAL_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
] as const;

/** The environment for a program that runs git in a folder of its own: this one's, without what points git at another repository. */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const own = new Set<string>(GIT_LOCAL_ENV);
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && !own.has(e[0])));
}
