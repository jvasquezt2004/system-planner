import { scenarioSupabaseTypePaths } from "./scenario-types";

export const edgeFunctionSupabaseTypePaths = {
	...scenarioSupabaseTypePaths,
	"jsr:@supabase/supabase-js@2": ["node_modules/@supabase/supabase-js/dist/index.d.mts"],
	"npm:@supabase/supabase-js@2": ["node_modules/@supabase/supabase-js/dist/index.d.mts"],
	"https://esm.sh/@supabase/supabase-js@2": ["node_modules/@supabase/supabase-js/dist/index.d.mts"],
};

export const edgeFunctionDenoDeclarations = `
declare namespace Deno {
  interface ServeOptions { port?: number; hostname?: string; }
  function serve(handler: (request: Request) => Response | Promise<Response>): void;
  function serve(options: ServeOptions, handler: (request: Request) => Response | Promise<Response>): void;
  namespace env { function get(name: "SUPABASE_URL" | "SUPABASE_ANON_KEY" | "SUPABASE_SERVICE_ROLE_KEY"): string | undefined; }
}
`;
