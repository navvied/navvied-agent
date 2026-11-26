const VERBS: Readonly<Record<string, readonly [string, string]>> = { capture: ["Looked at", "look at"], click: ["Clicked in", "click in"], type: ["Typed in", "type in"], key: ["Pressed keys in", "press keys in"], scroll: ["Scrolled", "scroll"], wait: ["Waited", "wait"], list: ["Listed the apps", "list the apps"] };

export function screenStepTitle(action: string, app: string, bad: boolean): string {
  const verb = VERBS[action];
  if (!verb) return app ? `Using ${app}` : "Using the computer";
  if (action === "list" || action === "wait") return bad ? `Could not ${verb[1]}` : verb[0];
  return `${bad ? `Could not ${verb[1]}` : verb[0]} ${app || (action === "capture" ? "the screen" : "")}`.trim();
}

export const noWindowSaid = (app: string): string => `No open window matches ${app}. Open it, then ask again.`;
