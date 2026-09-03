# ⚠️ This directory is a temporary staging location

**Market Analyst** has nothing to do with the camp bus system in this
repository's root. It is committed here purely to preserve the work: the
build environment is ephemeral, and repository-creation permission was not
available from this session (`403: Resource not accessible by integration`).

## Next step

1. Create a new **empty** GitHub repository named `market-analyst` (no README).
2. Move it there:

```bash
git clone https://github.com/abraaj1982/camp-checkin.git tmp
cd tmp && git checkout claude/professional-system-plan-nydfwi
cd market-analyst
rm WHERE-THIS-LIVES.md
git init -b main && git add -A
git commit -m "Import market analyst platform"
git remote add origin https://github.com/abraaj1982/market-analyst.git
git push -u origin main
```

3. Delete this directory from the `claude/professional-system-plan-nydfwi`
   branch.

## To try it right now, no move required

Copy the `market-analyst` folder to your machine and double-click
`run-demo.bat` — it runs with no internet and no API keys.
