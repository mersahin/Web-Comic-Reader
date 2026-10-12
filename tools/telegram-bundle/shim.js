// Minimal Node globals that GramJS expects in the browser.
import { Buffer } from 'buffer';

export { Buffer };
export const process = {
    env: {},
    browser: true,
    version: '',
    versions: {},
    nextTick: (fn, ...args) => Promise.resolve().then(() => fn(...args))
};
