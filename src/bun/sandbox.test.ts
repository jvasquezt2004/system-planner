import { expect, test } from "bun:test";
import { createPGliteSandbox } from "./sandbox";

test("design-check sandbox installs identity helpers and roles before design SQL", async () => {
	const sandbox = createPGliteSandbox();
	try {
		const result = await sandbox.apply(`
			CREATE TABLE public.identity_probe (
				user_id uuid DEFAULT auth.uid(),
				request_role text DEFAULT auth.role(),
				request_claims jsonb DEFAULT auth.jwt()
			);
			ALTER TABLE public.identity_probe ENABLE ROW LEVEL SECURITY;
			CREATE POLICY identity_probe_policy ON public.identity_probe
				TO anon, authenticated, service_role
				USING (user_id = auth.uid())
				WITH CHECK (user_id = auth.uid());
		`);
		expect(result.ok).toBe(true);
	} finally {
		await sandbox.dispose();
	}
}, 90_000);
