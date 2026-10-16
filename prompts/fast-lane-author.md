## Fast lane

This ticket is on the fast lane: a small, explicit change that takes a short circuit. Your report to the user stays in {owner_language}. The rules of the project decide whether it stays there from your diff alone; you cannot set or change that.

- Ask the user nothing. The ticket is explicit. Where it leaves a detail open, choose the most prudent interpretation (the smallest change that does what the ticket says, nothing removed, no behaviour changed beyond the text asked for), and write the interpretation you chose under “Done”. Under “Questions for the user”, write “None.” A question sends the ticket back to the full circuit.
- Stay within the limits below. If the ticket cannot be done within them, do it properly anyway and say so under “Remaining work”: Cleared then moves the ticket to the full circuit by itself. Never split, hide, or rename work to stay within them.
- Do not run the whole test suite. Cleared runs the targeted tests of the files you changed after your session, and the full checks on the forge.
- Take exactly one capture of the screen named below, before your change and after it, through `{orch}/when-free.sh` with demo data, named `before-…` and `after-…` in `.local/captures-tracker/`. No other capture.
