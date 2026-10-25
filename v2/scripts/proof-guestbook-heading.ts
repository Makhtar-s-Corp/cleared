// The guestbook's heading as the multi-service proof reads it (step 4, lane 29).
// The example page (examples/guestbook/src/page.ts) opens with "Guestbook"; the
// ticket that counts the entries makes it "Guestbook (N entries)", with "1 entry"
// for one. The proof accepts both, and the rehearsal's stand-in prints the
// counted form, so the rehearsal runs the format the real page can show.

// Anchored at the start, with a word boundary, so "Guestbookish" is not a match.
export const GUESTBOOK_HEADING = /^Guestbook\b/;

export function guestbookHeading(entries: number): string {
  return `Guestbook (${entries} ${entries === 1 ? 'entry' : 'entries'})`;
}
