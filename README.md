# claude-runner-ui

A small web UI for running **headless Claude Code jobs** on an always-on Linux box, such as a Raspberry Pi. It is meant to be reached over **Tailscale**.

- Type a request ("run the daily job", "only check source X") and press Start. The job runs on the server, so you can close the browser.
- Watch a live log while it runs. Cancel it if needed.
- A **Rules** page lets you edit the prompt and rule files (allowlisted in config) without starting a job. Each save keeps the previous version, and a save is refused if the file changed on disk since you opened it.
- **Item actions:** when a run lists individual results (e.g. jobs found), each one gets buttons from your config. A button can run a command (with an optional note dialog) or start a follow-up Claude job for that item, such as "evaluate this one". Follow-up jobs queue behind the running job, and their result opens in a large dialog.
- Every run is kept in a **history**: date, request, trigger (web/cron/cli), status, duration and cost. It also lists the **platforms and keywords** Claude used, from `meta.json`.
- Each finished run is **emailed** through any sendmail-compatible command, e.g. `msmtp`.
- Cron jobs use the same runner, so scheduled runs show up in the same history.

It has no npm dependencies: plain Node ≥ 20 and one HTML page.

```
server.mjs            web server + JSON API
bin/run-job.mjs       runs one job: claude -p → runs/<id>/ → email
lib/config.mjs        shared config / run-folder helpers
public/index.html     the UI
systemd/              user service unit
examples/crontab.txt  scheduled runs
```

## How a job works

1. The runner builds a prompt from three parts:
   - your `promptFile`;
   - the request typed in the UI;
   - a **runner contract** that tells Claude it is unattended (it must never ask questions) and where to write its output.
2. It runs `claude -p` in `projectDir` with `--output-format stream-json`, an `--allowedTools` allowlist, and an optional `--mcp-config`.
3. Claude writes two files:
   - `result.md`: the human-readable result (shown in the UI and emailed);
   - `meta.json` (optional), which feeds the platforms/keywords columns:
     ```json
     {"summary": "3 new items",
      "badge": "optional short verdict, e.g. 4.2/5",
      "items": [{"title": "…", "url": "https://…", "company": "…", "location": "…"}],
      "sources": [{"platform": "Site A", "keywords": ["foo", "bar"], "location": "Finland",
                   "status": "ok", "found": 12, "kept": 3, "note": ""}]}
     ```
4. Everything for a run is kept in `runs/<YYYYMMDD-HHMMSS>/`: `status.json`, `request.txt`, `claude.log`, `events.jsonl`, `result.md` and `meta.json`.

Only one job runs at a time; a lock is held in `runs/.lock`.

## Install (Raspberry Pi OS 64-bit / Debian / Ubuntu)

```bash
# 1. Node 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git msmtp msmtp-mta

# 2. Claude Code CLI + auth
curl -fsSL https://claude.ai/install.sh | bash
claude            # then /login. Or run `claude setup-token` on another machine
                  # and put CLAUDE_CODE_OAUTH_TOKEN=... in an env file (see envFile)

# 3. Tailscale (skip if already set up)
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up

# 4. This repo
git clone <your-repo-url> ~/claude-runner-ui
cd ~/claude-runner-ui
cp config.example.json config.json && nano config.json
```

### Email (msmtp + Gmail app password)

Create `~/.msmtprc` and run `chmod 600 ~/.msmtprc`:

```
defaults
auth on
tls on
tls_trust_file /etc/ssl/certs/ca-certificates.crt
logfile ~/.msmtp.log

account gmail
host smtp.gmail.com
port 587
from you@gmail.com
user you@gmail.com
passwordeval "cat ~/.config/msmtp/gmail-app-password"

account default : gmail
```

Test it with:
```bash
printf "Subject: test\n\nhi" | msmtp you@gmail.com
```

## Configuration (`config.json`)

| Key | Meaning |
|-----|---------|
| `host` | `"auto"` uses the Tailscale IPv4 (`tailscale ip -4`). It can be a specific IP, or `127.0.0.1` for local testing. **`0.0.0.0` is refused.** |
| `port` | Default `8787`. |
| `projectDir` | Folder Claude runs in. Its `CLAUDE.md`, skills and settings apply. |
| `promptFile` | Base prompt for every job. The request typed in the UI is appended to it. |
| `editableFiles` | Files that can be edited on the **Rules** page: a list of `{ "label", "path", "group" }` (or plain paths). Each `group` becomes its own tab; the default group is "Rules". `.yml`/`.yaml` saves with tab indentation are refused, and `.json` saves must parse. Relative paths resolve from `projectDir`. If you leave it out, only `promptFile` is editable. |
| `mcpConfig` | Optional MCP config file passed to `--mcp-config`. Use headless browsers on a server, e.g. `@playwright/mcp --headless`. |
| `allowedTools` | Comma-separated tool allowlist for `--allowedTools`, e.g. `Read,Write,Edit,Glob,Grep,Bash(node *),mcp__playwright__*`. |
| `model` | Optional `--model` override. |
| `timeout` | Kill the job after this long: `90m`, `2h`, `300s`. |
| `envFile` | Optional `KEY=VALUE` file loaded before running Claude, e.g. `CLAUDE_CODE_OAUTH_TOKEN`. |
| `runsDir` | Where run history is stored. Default `./runs`. |
| `mail` | `{ "to", "from", "command" }`. The command reads a full message on stdin (`msmtp -t`). Set it to `null` to disable email. Cancelled runs are not emailed. |
| `presets` | Quick-pick request chips shown in the UI. |
| `items.label` | Heading for the per-item list on a run page (e.g. `"Jobs found"`). |
| `itemActions` | Buttons shown on each item. See [Item actions](#item-actions). |

Relative paths are resolved from the repo folder. Set `RUNNER_CONFIG=/path/to/config.json` to use a different config file.

## Item actions

When Claude lists `items` in `meta.json`, the run page shows them with one button per entry in `itemActions`:

```json
"items": { "label": "Jobs found" },
"itemActions": [
  { "id": "applied", "type": "command", "label": "Applied", "doneLabel": "Applied ✓", "askNote": true,
    "command": ["node", "scripts/mark-applied.mjs"] },
  { "id": "evaluate", "type": "job", "label": "Evaluate", "runningLabel": "Evaluating…", "doneLabel": "Evaluated",
    "promptFile": "prompts/evaluate.md", "request": "Evaluate: {title} at {company}. URL: {url}" }
]
```

- **`command`** runs the program in `projectDir`, with no shell and a 60-second limit.
  - It receives `{"item": {...}, "note": "...", "date": "YYYY-MM-DD", "action": "<id>"}` as JSON on stdin.
  - Exit code 0 marks the item done. Anything else shows the output as an error and offers a retry.
  - With `askNote`, a dialog asks for a date and a note first.
- **`job`** starts a normal runner job: the same history, log and email, with trigger `action:<id>`.
  - `request` is filled from the item's fields (`{title}`, `{url}`, …), and `promptFile` (relative to `projectDir`) replaces the default prompt.
  - These jobs **queue**. If another job is running they wait, first in first out, and start automatically.
  - The button shows Queued…, then the `runningLabel`, then the `doneLabel` plus the job's `badge`. Clicking it after it's done opens the result in a large dialog.
- Item data always comes from the run's `meta.json` on the server; the browser only sends the item's position in the list.
- Item state is kept in `runs/items.json`, keyed by the item's URL. A job found again in a later run keeps its Applied/Evaluated state.

## Run it as a service

```bash
mkdir -p ~/.config/systemd/user
cp systemd/claude-runner-ui.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-runner-ui
loginctl enable-linger $USER          # keep it running while logged out / after reboot
journalctl --user -u claude-runner-ui -f
```

Open `http://<tailscale-ip>:8787` from any device on your tailnet.

**Optional HTTPS** with a nice name:
```bash
sudo tailscale serve --bg 8787
```
After that the UI is at `https://<machine>.<tailnet>.ts.net`.

## Scheduled runs (cron)

```bash
crontab -e
```
Use the line from `examples/crontab.txt`:
```cron
0 7 * * 1,3,5  /usr/bin/env node $HOME/claude-runner-ui/bin/run-job.mjs auto "run the daily job" cron >> $HOME/claude-runner-ui/runs/cron.log 2>&1
```

Manual run from a shell:
```bash
node bin/run-job.mjs auto "your request" cli
```

## Security notes

- The server only listens on the Tailscale interface by default. Anyone on your tailnet can start jobs, so use Tailscale ACLs if you share the tailnet.
- Requests are passed to the runner as a single argument and never go through a shell. They are capped at 500 characters.
- Claude can only use the tools in `allowedTools`. Keep the list as narrow as your job allows.
- The Rules page can only open files listed in `editableFiles`. Files are addressed by their position in that list, never by a path sent from the browser. The last 20 versions of each file are kept in `runs/.versions/`.
- Result Markdown is sanitized (DOMPurify) before it is shown.
- The UI loads `marked` and `DOMPurify` from cdnjs. If they can't load, the result is shown as plain text.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `host is "auto" but no Tailscale IPv4 was found` | Run `tailscale up`, or set `host` explicitly. |
| Run fails with "Not logged in" | Log in with `claude` → `/login` as the same user, or set the token in `envFile`. |
| `claude: command not found` in cron | The runner adds `~/.local/bin`, `~/.npm-global/bin` and `/usr/local/bin` to PATH. If `claude` lives somewhere else, set PATH in the crontab. |
| Run shows `failed: runner process stopped unexpectedly` | The machine rebooted or the runner crashed mid-run. Check `runs/<id>/claude.log`. |
| No email | Check `~/.msmtp.log` and the end of `runs/<id>/claude.log`. |

## License

MIT
