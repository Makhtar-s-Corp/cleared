#!/usr/bin/env node
// The entry point to the configured ticket tracker, as tracker.sh was: it
// hands over to lib/tracker/adapters/dispatch.ts.
//
//   tracker.ts <command> [<argument>...]
import './lib/tracker/adapters/dispatch.ts';
