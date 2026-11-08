import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAssistantRuntime } from "./assistant-runtime";
import { openProjectFileStore, type ProjectFileStore } from "./project-files";
import { createDesignWorkspace } from "./workspace";

setDefaultTimeout(30_000);

const directories: string[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("the Assistant lists and reads the files attached to the Project, in parts, and cannot read another Project's", async () => {
	const directory = mkdtempSync(join(tmpdir(), "assistant-project-files-"));
	directories.push(directory);
	const databasePath = join(directory, "project.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	const store: ProjectFileStore = openProjectFileStore(databasePath);
	const project = await workspace.createProject({ name: "Restaurant" });
	const other = await workspace.createProject({ name: "Other" });
	await store.add(other.project!.id, { name: "secret.txt", bytes: new TextEncoder().encode("belongs to another project") });
	await workspace.openProject({ projectId: project.project!.id });
	await store.add(project.project!.id, { name: "spec.md", bytes: new TextEncoder().encode(`Orders are split per station. ${"x".repeat(40_000)}`) });
	await store.add(project.project!.id, { name: "logo.png", bytes: new Uint8Array([1, 2, 3]) });

	const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
	const models = createModels();
	models.setProvider(scripted.provider);
	const requests: string[] = [];
	const runtime = createAssistantRuntime({
		databasePath, workspace, models, getApiKey: async () => "test-key", projectFiles: store,
		streamFn: async (model, context, options) => { requests.push(JSON.stringify(context.messages)); return models.streamSimple(model, context, options); },
	});
	closers.push(() => runtime.close(), () => store.close(), () => workspace.close());
	const conversation = runtime.createConversation(project.project!.id);
	scripted.setResponses([
		fauxAssistantMessage([fauxToolCall("read_project_file", {}), fauxToolCall("read_project_file", { name: "SPEC.md" }), fauxToolCall("read_project_file", { name: "logo.png" }), fauxToolCall("read_project_file", { name: "secret.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("read_project_file", { name: "spec.md", offset: 30_000 })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Read them.")]),
	]);
	await runtime.sendMessage(conversation.id, "Use the spec.", "scripted-model");

	const transcript = requests[requests.length - 1];
	expect(transcript).toContain("spec.md");
	expect(transcript).toContain("Orders are split per station.");
	expect(transcript).toContain("nextOffset");
	expect(transcript).toContain("An image: it has no text to read.");
	expect(transcript).toContain("No Project file is named secret.txt");
	expect(transcript).not.toContain("belongs to another project");
	// The second read continues where the first stopped and reaches the end.
	expect(transcript).toContain('\\"offset\\":30000');
	expect(transcript).toContain('\\"nextOffset\\":null');
});
