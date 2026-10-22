import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { DesignEnumType } from "../shared/design";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Edits design-level enum names and labels with one commit per completed field. */
export function EnumTypeEditor({
	enumTypes,
	busy,
	onChange,
}: {
	enumTypes: DesignEnumType[];
	busy: boolean;
	onChange: (enumTypes: DesignEnumType[]) => void;
}) {
	const [nameDrafts, setNameDrafts] = useState<Record<string, string | undefined>>({});
	const [labelDrafts, setLabelDrafts] = useState<Record<string, string | undefined>>({});
	return (
		<Section
			id="enum-types-heading"
			title="Enum types"
			action={
				<Button
					variant="ghost"
					size="xs"
					disabled={busy}
					onClick={() => onChange([
						...enumTypes,
						{ id: crypto.randomUUID(), name: "status", labels: ["draft", "active"] },
					])}
				>
					<Plus /> Add enum
				</Button>
			}
		>
			{enumTypes.map((enumType) => (
				<div key={enumType.id} className="flex flex-col gap-2 border-y border-rule px-6 py-2">
					<div className="flex gap-2">
						<Input
							aria-label="Enum type name"
							value={nameDrafts[enumType.id] ?? enumType.name}
							disabled={busy}
							onChange={(event) => setNameDrafts((drafts) => ({
								...drafts,
								[enumType.id]: event.target.value,
							}))}
							onBlur={() => {
								const name = nameDrafts[enumType.id]?.trim();
								if (name && name !== enumType.name) {
									onChange(enumTypes.map((item) =>
										item.id === enumType.id ? { ...item, name } : item,
									));
								}
								setNameDrafts((drafts) => ({ ...drafts, [enumType.id]: undefined }));
							}}
							onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
						/>
						<Button
							variant="strike"
							size="xs"
							aria-label="Remove enum type"
							disabled={busy}
							onClick={() => onChange(enumTypes.filter((item) => item.id !== enumType.id))}
						>
							<Trash2 />
						</Button>
					</div>
					<ul className="space-y-1">
						{enumType.labels.map((label, index) => {
							const draftKey = `${enumType.id}:${index}`;
							return (
								<li key={draftKey} className="flex gap-2">
									<Input
										aria-label={`Enum label ${index + 1}`}
										value={labelDrafts[draftKey] ?? label}
										disabled={busy}
							onChange={(event) => setLabelDrafts((drafts) => ({
								...drafts,
								[draftKey]: event.target.value,
							}))}
										onBlur={() => {
											const nextLabel = labelDrafts[draftKey]?.trim();
								if (nextLabel && nextLabel !== label) {
									onChange(enumTypes.map((item) =>
										item.id === enumType.id
											? {
												...item,
												labels: item.labels.map((value, at) =>
													at === index ? nextLabel : value,
												),
											}
											: item,
									));
								}
											setLabelDrafts((drafts) => ({ ...drafts, [draftKey]: undefined }));
										}}
										onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
									/>
						<Button
							variant="strike"
							size="xs"
							aria-label={`Remove enum label ${label}`}
							disabled={busy || enumType.labels.length <= 1}
							onClick={() => onChange(enumTypes.map((item) =>
							item.id === enumType.id
								? { ...item, labels: item.labels.filter((_, at) => at !== index) }
								: item,
						))}
						>
							<Trash2 />
						</Button>
								</li>
							);
						})}
					</ul>
					<Button
						variant="ghost"
						size="xs"
						className="self-start"
						disabled={busy}
						onClick={() => onChange(enumTypes.map((item) =>
							item.id === enumType.id
								? { ...item, labels: [...item.labels, `label_${item.labels.length + 1}`] }
								: item,
						))}
					>
						<Plus /> Add label
					</Button>
				</div>
			))}
		</Section>
	);
}

function Section({
	id,
	title,
	action,
	children,
}: {
	id: string;
	title: string;
	action: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section aria-labelledby={id} className="mt-5">
			<header className="flex h-7 items-center justify-between pr-4 pl-6">
				<h3 id={id} className="kicker">{title}</h3>
				{action}
			</header>
			{children}
		</section>
	);
}
