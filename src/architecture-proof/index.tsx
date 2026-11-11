import { useEffect, useState } from "react";
import { CustomArchitectureCanvas } from "./custom-canvas";
import { ReactFlowEvaluation } from "./reactflow-evaluation";
import { runWebViewProof } from "./webview-proof";
import { cn } from "@/lib/utils";

export type ProofTab = "canvas" | "evaluation";

export function ArchitectureProofView() {
	const [tab, setTab] = useState<ProofTab>("canvas");
	useEffect(() => {
		const reportUrl = new URLSearchParams(window.location.search).get("proofReportUrl");
		if (reportUrl) void runWebViewProof(reportUrl);
	}, []);

	return (
		<div className="flex flex-col h-full bg-[#fcfbf7] overflow-hidden" data-testid="architecture-proof-view">
			{/* Explicit Technical Proof Notice Banner */}
			<div className="flex items-center justify-between px-4 py-1.5 bg-amber-50/90 border-b border-amber-200 shrink-0 text-xs text-amber-900">
				<div className="flex items-center gap-2">
					<span className="font-mono text-[10px] font-bold uppercase bg-amber-200 text-amber-950 px-1.5 py-0.5 rounded">
						Technical Proof Fixture (#117)
					</span>
					<span className="text-xs text-amber-800">
						Bounded technical proof evaluating canvas libraries & SVG playback — not the production authoritative System-design editor.
					</span>
				</div>

				<div className="font-mono text-[10.5px] text-amber-700">
					ADR-0005 / ADR-0007 / ADR-0010
				</div>
			</div>

			{/* Sub-header Tab Bar */}
			<div className="flex items-center justify-between px-4 py-1.5 bg-paper-soft border-b border-rule shrink-0 text-xs">
				<div className="flex items-center gap-1.5 font-display">
					<button
						type="button"
						onClick={() => setTab("canvas")}
						data-testid="tab-custom-canvas"
						className={cn(
							"px-3 py-1 rounded transition-colors font-medium flex items-center gap-1.5",
							tab === "canvas"
								? "bg-white shadow-xs text-ink border border-rule/50"
								: "text-ink-3 hover:text-ink hover:bg-white/50",
						)}
					>
						<span>Architecture Canvas Proof (Custom)</span>
					</button>

					<button
						type="button"
						onClick={() => setTab("evaluation")}
						data-testid="tab-reactflow-eval"
						className={cn(
							"px-3 py-1 rounded transition-colors font-medium flex items-center gap-1.5",
							tab === "evaluation"
								? "bg-white shadow-xs text-ink border border-rule/50"
								: "text-ink-3 hover:text-ink hover:bg-white/50",
						)}
					>
						<span>React Flow Candidate Evaluation</span>
					</button>
				</div>

				<div className="text-[11px] font-mono text-ink-3">
					Fixture: Image Upload System with Parallel Steps & Retries
				</div>
			</div>

			{/* Tab Content */}
			<div className="flex-1 relative overflow-hidden">
				{tab === "canvas" ? <CustomArchitectureCanvas /> : <ReactFlowEvaluation />}
			</div>
		</div>
	);
}
