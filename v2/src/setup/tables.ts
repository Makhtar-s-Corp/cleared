// The setup assistant's tables, which the service's setup module creates
// and the app creates too (it checks the setup code before the service has
// answered anything): the code and the steps' records.
import { SETUP_CODE_TABLE } from './code.ts';
import { SETUP_STEPS_TABLE } from './records.ts';

export const SETUP_TABLES: readonly string[] = [SETUP_CODE_TABLE, SETUP_STEPS_TABLE];
