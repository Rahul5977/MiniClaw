# Task benchmark: llama3.1:8b

- 30 tasks × 1 run(s), 2026-10-03 12:19
- The simulated user approves every action; web content is faked for repeatable results.

| Metric | Value |
|---|---|
| **Task success rate** | **18/30 (60%)** |
| Tool-call validity | 37/39 (95%) |
| Avg model steps per task | 2.1 |
| Avg time per task | 21.4 s |
| Avg prompt tokens per task | 3,445 |
| Runs needing a nudge | 1/30 |

| Category | Success |
|---|---|
| chat | 2/3 (67%) |
| files | 5/7 (71%) |
| shell | 1/2 (50%) |
| web | 2/3 (67%) |
| memory | 2/3 (67%) |
| reminders | 3/4 (75%) |
| notes | 1/1 (100%) |
| skills | 1/3 (33%) |
| multi-step | 1/4 (25%) |

Failures:

- `chat-no-tools`: used tools or no joke
- `file-copy`: final.txt missing or different
- `file-find`: b.txt not named
- `shell-mkdir`: not moved
- `web-to-file`: solar.md missing or off-topic
- `memory-propose`: no memory proposed
- `reminder-daily`: no daily 08:00 reminder
- `skill-weather`: temperature missing
- `skill-journal`: journal entry missing
- `multi-summary-file`: summary.md missing or not 2 bullets
- `multi-csv-total`: total.txt has: 0
- `multi-web-reminder`: no reminder at 09:00 on 20 Oct
