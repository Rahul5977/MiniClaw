# Task benchmark: qwen2.5:7b

- 30 tasks × 1 run(s), 2026-10-03 12:08
- The simulated user approves every action; web content is faked for repeatable results.

| Metric | Value |
|---|---|
| **Task success rate** | **22/30 (73%)** |
| Tool-call validity | 33/33 (100%) |
| Avg model steps per task | 2.0 |
| Avg time per task | 12.1 s |
| Avg prompt tokens per task | 3,214 |
| Runs needing a nudge | 1/30 |

| Category | Success |
|---|---|
| chat | 3/3 (100%) |
| files | 3/7 (43%) |
| shell | 1/2 (50%) |
| web | 3/3 (100%) |
| memory | 3/3 (100%) |
| reminders | 3/4 (75%) |
| notes | 1/1 (100%) |
| skills | 3/3 (100%) |
| multi-step | 2/4 (50%) |

Failures:

- `file-list-count`: wrong count
- `file-json`: config.json missing or not valid JSON
- `file-copy`: final.txt missing or different
- `file-find`: b.txt not named
- `shell-mkdir`: not moved
- `reminder-daily`: no daily 08:00 reminder
- `multi-csv-total`: total.txt has: Total amount: $5200
- `multi-web-reminder`: no reminder at 09:00 on 20 Oct
