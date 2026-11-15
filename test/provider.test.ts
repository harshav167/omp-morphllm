import { expect, test } from "bun:test";
import { MORPH_PROVIDER_CONFIG } from "../src/provider";

type Login = NonNullable<typeof MORPH_PROVIDER_CONFIG.oauth>["login"];
type Callbacks = Parameters<Login>[0];

/** Runs `/login morph` with a pasted key against a Morph that answers `status`. */
async function login(pasted: string, status: number) {
  const opened: string[] = [];
  const sent: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const callbacks: Callbacks = {
    onAuth: (info) => {
      opened.push(info.url);
    },
    onPrompt: async () => pasted,
    fetch: async (input, init) => {
      sent.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return new Response("{}", { status });
    },
  };
  const login = MORPH_PROVIDER_CONFIG.oauth?.login;
  if (!login) throw new Error("The provider has no login");
  return { result: login(callbacks), opened, sent };
}

test("login opens the key page and returns the key that Morph accepts", async () => {
  // Morph answers 400 to the probe when the key is valid: the probe has no messages.
  const { result, opened, sent } = await login("  Bearer sk-fixture \n", 400);
  expect(await result).toBe("sk-fixture");
  expect(opened).toEqual(["https://www.morphllm.com/dashboard/api-keys"]);
  expect(sent).toEqual([
    {
      url: "https://api.morphllm.com/v1/chat/completions",
      authorization: "Bearer sk-fixture",
      body: { model: "morph-kimik31", messages: [] },
    },
  ]);
});

test("login rejects a key that Morph does not accept, and an empty key", async () => {
  await expect((await login("sk-revoked", 401)).result).rejects.toThrow("did not accept");
  const empty = await login("   ", 400);
  await expect(empty.result).rejects.toThrow("No Morph API key");
  expect(empty.sent).toHaveLength(0);
});
