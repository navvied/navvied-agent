import { noWindowSaid, screenStepTitle, type ScreenOutcome } from "@navvied/protocol";

export interface Refusal { title: string; said: string }

export function refusalWords(screen: ScreenOutcome, action = ""): Refusal | undefined {
  if (screen.verdict !== "refused") return undefined;
  if (screen.reason === "no_window") return { title: screenStepTitle(action, screen.app ?? "", true), said: noWindowSaid(screen.app || "the app") };
  const app = screen.app || "the app";
  switch (screen.code) {
    case "background_unavailable": return { title: `Could not work in ${app}`, said: `${app} is hidden. Let navvied bring it to the front.` };
    case "background_occluded": return { title: `Could not click in ${app}`, said: `Another window covers ${app}. Move it, or let navvied bring ${app} to the front.` };
    case "background_uipi_blocked": return { title: `Could not click in ${app}`, said: "This program needs higher rights, so navvied cannot control it." };
    case "human_has_control": return { title: `Could not click in ${app}`, said: "You are using the screen. navvied waits." };
    case "input_target_mismatch": return { title: "Stopped before typing", said: "The window in front changed. Nothing was typed." };
    case "permission_missing": return /screen/i.test(screen.which ?? "")
      ? { title: "Could not see the screen", said: "Allow Screen Recording for navvied in the system settings." }
      : { title: `Could not click in ${app}`, said: "Allow Accessibility for navvied in the system settings." };
    case "blocked_by_policy": return { title: `Could not open ${app}`, said: "Blocked by a rule. navvied stays out of passwords, banking and payments." };
    default: return undefined;
  }
}
