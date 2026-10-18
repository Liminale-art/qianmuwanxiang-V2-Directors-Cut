import { createDirectorHostState } from '../../qianmu-director-host-state.js';

export function directorHostFixture(overrides = {}) {
    const module = { isGenerating: () => false, isChatSaving: false, streamingProcessor: null,
        closeCurrentChat: async () => true, ...overrides };
    return { module, state: createDirectorHostState({ loadHost: async () => module }) };
}
