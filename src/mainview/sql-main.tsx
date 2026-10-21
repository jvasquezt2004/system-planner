import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { WorkspaceState } from "../shared/design";
import "./index.css";
import { sqlWindowClient } from "./sql-window-client";
import { SqlWindow } from "./sql-window";

function SqlWindowApp() {
	const [state, setState] = useState<WorkspaceState | null>(null);

	useEffect(() => {
		const unsubscribe = sqlWindowClient.subscribe(setState);
		// A pushed state that arrives first is newer than the initial load.
		void sqlWindowClient.load().then((loaded) => setState((current) => current ?? loaded));
		return unsubscribe;
	}, []);

	return state ? (
		<SqlWindow state={state} />
	) : (
		<main className="flex h-screen items-center justify-center bg-paper">
			<p role="status" className="font-display text-[18px] text-ink-3 italic">
				Setting the SQL preview…
			</p>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<SqlWindowApp />
	</StrictMode>,
);
