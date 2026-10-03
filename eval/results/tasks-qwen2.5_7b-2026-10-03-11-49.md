# Task benchmark: qwen2.5:7b

- 30 tasks × 1 run(s), 2026-10-03 11:49
- The simulated user approves every action; web content is faked for repeatable results.

| Metric | Value |
|---|---|
| **Task success rate** | **23/30 (77%)** |
| Tool-call validity | 45/47 (96%) |
| Avg model steps per task | 2.3 |
| Avg time per task | 14.5 s |
| Avg prompt tokens per task | 3,751 |
| Runs needing a nudge | 1/30 |

| Category | Success |
|---|---|
| chat | 3/3 (100%) |
| files | 4/7 (57%) |
| shell | 1/2 (50%) |
| web | 3/3 (100%) |
| memory | 3/3 (100%) |
| reminders | 3/4 (75%) |
| notes | 1/1 (100%) |
| skills | 3/3 (100%) |
| multi-step | 2/4 (50%) |

Failures:

- `file-list-count`: wrong count
- `file-copy`: final.txt missing or different
- `file-find`: b.txt not named
- `shell-mkdir`: not moved
- `reminder-daily`: no daily 08:00 reminder
- `multi-csv-total`: total.txt has: Total amount: 0
- `multi-web-reminder`: no reminder at 09:00 on 20 Oct
