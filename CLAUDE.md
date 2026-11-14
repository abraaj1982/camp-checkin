# MUKHAYYAM camp platform — working rules

## Simplicity first (most important)
- Always pick the simplest solution that reliably does the job.
- No new technologies, frameworks, services, databases or layers unless they solve a real problem on camp day.
- Reuse what exists (GitHub Pages + one Apps Script + Google Sheets). No enterprise architecture.
- Every new feature must answer: Is it needed? Does it solve a real problem? Can the current system already do it? Does it make the day easier? Is the maintenance worth it?
- If a simpler way exists, recommend it. More features is not a better system.

## Safety rules
- Never touch the production sheet, production Apps Script or `main` without the owner's explicit approval. Test on the TEST copy.
- The repo is public: no real student data, photos, medical/financial data, real staff names or secrets.
- Tokens never in URLs. Passwords are never retrievable. Guardian phones are never sent to supervisors/leaders.
- Users and permissions are managed from the app (hub), never by editing the sheet.

## Working style
- The owner pastes server files into the TEST Apps Script and deploys "New version". Explain steps simply, in Arabic.
- Test each screen before building the next. Run `node tests/server.test.js` before every push.
