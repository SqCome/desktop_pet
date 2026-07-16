"use strict";
// Shared types between main and renderer.
Object.defineProperty(exports, "__esModule", { value: true });
exports.IPC = exports.DEFAULT_CONFIG = void 0;
exports.DEFAULT_CONFIG = {
    alwaysOnTop: true,
    maxFps: 60,
    startHidden: false,
    llm: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini',
    },
};
/** Channels used across IPC. Keep them in one place so both ends agree. */
exports.IPC = {
    CHAT_SEND: 'chat:send',
    CHAT_STREAM: 'chat:stream',
    CHAT_STOP: 'chat:stop',
    CONFIG_GET: 'config:get',
    CONFIG_SET: 'config:set',
    PET_DRAG: 'pet:drag',
    PET_INTERACTION: 'pet:interaction',
};
