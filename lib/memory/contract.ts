// Storage-independent memory interface. Other Cleared code imports only this file.
import { LocalMemory } from './adapters/local.ts';

/** @typedef {'decision'|'glossary'|'project'|'lesson'|'handover'|'event'} MemoryType */
/** @typedef {'proposed'|'approved'|'superseded'|'archived'} MemoryStatus */
/** @typedef {{id?:string,type:MemoryType,scope:string,content:string,source_who:string,source_where:string,source_when?:string,status?:MemoryStatus,links?:string[],supersedes?:string,last_used_at?:string}} MemoryEntry */

export function createMemory(options = {}) { return new LocalMemory(options); }
