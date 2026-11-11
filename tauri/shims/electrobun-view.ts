import type { ElectrobunRPCSchema, TauriRpc } from "./electrobun-rpc";

/**
 * Stand-in for `electrobun/view`. Constructing it subscribes to backend pushes,
 * which is the only thing the view relies on `Electroview` for.
 */
export class Electroview {
	constructor({ rpc }: { rpc: TauriRpc<ElectrobunRPCSchema> | TauriRpc<any> }) {
		void rpc.__listen();
	}
}
