# Task benchmark: qwen2.5:7b

- 30 tasks × 2 run(s), 2026-10-03 12:34
- The simulated user approves every action; web content is faked for repeatable results.

| Metric | Value |
|---|---|
| **Task success rate** | **44/60 (73%)** |
| Tool-call validity | 71/71 (100%) |
| Avg model steps per task | 2.1 |
| Avg time per task | 11.4 s |
| Avg prompt tokens per task | 3,474 |
| Runs needing a nudge | 3/60 |

| Category | Success |
|---|---|
| chat | 6/6 (100%) |
| files | 7/14 (50%) |
| shell | 2/4 (50%) |
| web | 6/6 (100%) |
| memory | 6/6 (100%) |
| reminders | 6/8 (75%) |
| notes | 2/2 (100%) |
| skills | 6/6 (100%) |
| multi-step | 3/8 (38%) |

Failures:

- `file-list-count`: wrong count
- `file-list-count`: wrong count
- `file-json`: config.json missing or not valid JSON
- `file-json`: config.json missing or not valid JSON
- `file-copy`: final.txt missing or different
- `file-copy`: final.txt missing or different
- `file-find`: b.txt not named
- `shell-mkdir`: not moved
- `shell-mkdir`: not moved
- `reminder-daily`: no daily 08:00 reminder
- `reminder-daily`: no daily 08:00 reminder
- `multi-csv-total`: total.txt has: Total amount:
- `multi-csv-total`: total.txt has: Total amount: $0.00
- `multi-web-reminder`: no reminder at 09:00 on 20 Oct
- `multi-web-reminder`: no reminder at 09:00 on 20 Oct
- `multi-project`: files missing or incomplete
