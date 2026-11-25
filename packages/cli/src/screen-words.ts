import type { ScreenOutcome } from "@navvied/protocol";

/** A refused step on the screen, in the words of the web page: what could not be done, and why. */
export interface Refusal { title: string; said: string }

/** `undefined` for a reason that has no words of its own: the step then shows what the tool said. */
export function refusalWords(screen: ScreenOutcome): Refusal | undefined {
  if (screen.verdict !== "refused") return undefined;
  const app = screen.app || "the app";
  switch (screen.code) {
    case "background_unavailable": return { title: `Could not work in ${app}`, said: `${app} cannot be used while it is hidden. navvied can bring it to the front if you allow it.` };
    case "background_occluded": return { title: `Could not click in ${app}`, said: `Another window is covering it. Move that window, or let navvied bring ${app} to the front.` };
    case "background_uipi_blocked": return { title: `Could not click in ${app}`, said: "This program runs with higher rights, so navvied cannot control it." };
    case "human_has_control": return { title: `Could not click in ${app}`, said: "You are using the screen. navvied waits until you stop." };
    case "input_target_mismatch": return { title: "Stopped before typing", said: "The window in front changed, so navvied did not type. Nothing was entered." };
    case "permission_missing": return /screen/i.test(screen.which ?? "")
      ? { title: "Could not see the screen", said: "Screen Recording is not allowed for navvied. Allow it in the system settings." }
      : { title: `Could not click in ${app}`, said: "Accessibility is not allowed for navvied. Allow it in the system settings." };
    case "blocked_by_policy": return { title: `Could not open ${app}`, said: "A rule blocks this app. navvied stays out of apps that hold passwords, banking and payments." };
    default: return undefined;
  }
}
