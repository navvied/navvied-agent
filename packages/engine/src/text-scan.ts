/**
 * A scan of text that will be put in front of the model later (a note it kept, a skill it wrote), because whatever sits in
 * memory or in a skill is read as instructions in every later conversation: one poisoned line stays there. It looks for text that
 * tries to override the model's rules, text that sends secrets away, and characters a person cannot see.
 */
import { redact } from "./redact.ts";

/** Zero-width and direction-changing characters, and the "tag" block: they hide text from a person and not from a model. */
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|\uDB40[\uDC00-\uDC7F]/gu;

/** The third item marks the shapes that are unmistakable on their own: only these refuse a job's prompt, which a person writes in plain words and may mention keys or downloads. */
const SHAPES: readonly [string, RegExp, boolean][] = [
  ["text that tells the model to ignore its rules", /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?|polic(y|ies))\b/i, true],
  ["text that asks to reveal or replace the system prompt", /\b(reveal|print|show|repeat|leak|output)\b[^.\n]{0,30}\b(system|hidden|initial)\s+(prompt|instructions?|message)\b|\bnew (system )?(instructions?|prompt)\s*:/i, true],
  ["text that asks to hide something from the person", /\b(do not|don't|never)\s+(tell|inform|mention|show|reveal)[^.\n]{0,30}\b(the )?(user|person|owner)\b|\bwithout (telling|informing|asking) the (user|person)\b/i, false],
  ["a role marker that pretends to be the conversation", /(^|\n)\s*(system|assistant)\s*:\s*\S|<\|(im_start|im_end|system)\|>|\[\/?INST\]|<\/?system>/i, false],
  ["a command that sends secrets away", /\b(curl|wget|nc|ncat)\b[^\n]*(\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASSW)|\.env\b|id_rsa|credentials|\.ssh\b|\/etc\/passwd)/i, true],
  ["a command that reads secret files and sends them", /\b(cat|base64|tar|zip)\b[^\n|]*(\.env\b|id_rsa|\.ssh\/|\.aws\/|credentials)[^\n]*\|\s*(curl|wget|nc|ncat)\b/i, true],
  ["a download piped into a shell", /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i, false],
  ["a change to the person's login keys or start-up files", /authorized_keys|>>?\s*~?\/?\.(bashrc|zshrc|profile)\b/i, false],
];

/** What is wrong with the text, in words, or nothing. Secrets are not a finding: they are put out of sight (see `clean`). */
export function scanText(text: string, onlyClear = false): string[] {
  const found: string[] = [];
  if (new RegExp(HIDDEN.source, "u").test(text)) found.push("characters a person cannot see");
  for (const [what, shape, clear] of SHAPES) if ((clear || !onlyClear) && shape.test(text)) found.push(what);
  return found;
}

/** The scan of what a person asks an unattended job to do: only what is clearly an injection (ignore the rules, reveal the prompt, send secrets away, hidden characters). */
export const scanPrompt = (text: string): string[] => scanText(text, true);

/** The text with hidden characters removed and secrets replaced, as it may be kept or shown. */
export const clean = (text: string): string => redact(text.replace(HIDDEN, ""));
