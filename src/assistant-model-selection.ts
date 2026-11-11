export type UsableModelCandidate = {
	id: string;
	connectionId: string;
	isDefault?: boolean;
};

/**
 * Given a list of available models and an optional current selection (connection + model),
 * returns a usable model candidate.
 *
 * If the current selection identifies a model that exists in `models` for its connection,
 * that candidate is returned.
 *
 * Otherwise (when the selection is stale, missing, or unusable with its connection),
 * falls back in order:
 * 1. The `isDefault` model in `models`.
 * 2. The first model of the given connection (if `connectionId` is provided).
 * 3. The first model in `models` overall.
 * 4. `null` if `models` is empty.
 */
export function pickUsableModel<T extends UsableModelCandidate>(
	models: readonly T[],
	connectionId?: string | null,
	modelId?: string | null,
): T | null {
	if (models.length === 0) return null;

	if (modelId) {
		const match = models.find((m) => {
			if (connectionId) {
				return m.connectionId === connectionId && m.id === modelId;
			}
			return m.id === modelId;
		});
		if (match) return match;
	}

	const defaultModel = models.find((m) => m.isDefault);
	if (defaultModel) return defaultModel;

	if (connectionId) {
		const firstForConn = models.find((m) => m.connectionId === connectionId);
		if (firstForConn) return firstForConn;
	}

	return models[0] ?? null;
}
