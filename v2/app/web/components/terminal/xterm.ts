// The terminal's package and its sheet, in a chunk of their own: the session
// screen imports this module dynamically (Terminal.tsx), so no other screen,
// and no session page before a take over, loads them. The sheet is a file
// of the app's origin, which the policy allows.
import '@xterm/xterm/css/xterm.css';

export { Terminal } from '@xterm/xterm';
export { FitAddon } from '@xterm/addon-fit';
