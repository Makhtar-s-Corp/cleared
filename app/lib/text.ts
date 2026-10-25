// What a human may write through the app: some text, no control characters, at most 4000 characters.
const TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]{1,4000}$/u;
export const validText = (text: unknown): text is string => typeof text === 'string' && text.trim().length > 0 && TEXT.test(text);
