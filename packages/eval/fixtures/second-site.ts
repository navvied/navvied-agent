export const SECOND_SITE = "localhost";

export async function mustAnswer(address: string, ask: (address: string) => Promise<Response> = fetch): Promise<void> {
  const cannot = (why: string): Error => new Error(`the fixture web's site cannot be reached at ${address}: ${why}`);
  const answer = await ask(address).catch((e: Error) => { throw cannot(e.message); });
  if (!answer.ok) throw cannot(`it answered ${answer.status}`);
}
