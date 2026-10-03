# Task benchmark: llama3.1:8b

- 30 tasks × 1 run(s), 2026-10-03 11:59
- The simulated user approves every action; web content is faked for repeatable results.

| Metric | Value |
|---|---|
| **Task success rate** | **10/30 (33%)** |
| Tool-call validity | 15/33 (45%) |
| Avg model steps per task | 2.0 |
| Avg time per task | 20.0 s |
| Avg prompt tokens per task | 3,153 |
| Runs needing a nudge | 0/30 |

| Category | Success |
|---|---|
| chat | 2/3 (67%) |
| files | 1/7 (14%) |
| shell | 1/2 (50%) |
| web | 0/3 (0%) |
| memory | 2/3 (67%) |
| reminders | 2/4 (50%) |
| notes | 1/1 (100%) |
| skills | 1/3 (33%) |
| multi-step | 0/4 (0%) |

Failures:

- `chat-no-tools`: used tools or no joke
- `file-create-todo`: todo.md missing or fewer than 3 bullets
- `file-append`: old lines lost or new line missing
- `file-list-count`: wrong count
- `file-json`: config.json missing or not valid JSON
- `file-copy`: final.txt missing or different
- `file-find`: b.txt not named
- `shell-mkdir`: not moved
- `web-summary`: not fetched or not a bulleted summary
- `web-json-field`: star count missing
- `web-to-file`: solar.md missing or off-topic
- `memory-propose`: no memory proposed
- `reminder-daily`: no daily 08:00 reminder
- `reminder-cancel`: left: Go to the gym, Call mom
- `skill-weather`: temperature missing
- `skill-journal`: journal entry missing
- `multi-summary-file`: summary.md missing or not 2 bullets
- `multi-csv-total`: total.txt has: 0
- `multi-web-reminder`: no reminder at 09:00 on 20 Oct
- `multi-project`: files missing or incomplete
