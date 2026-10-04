# Scene 2: plan mode (I-2): approve a whole task once, then see what changed.
Output demo/out/02-plan.mp4
Source demo/tapes/_settings.tape

Hide
Type "demo/setup.sh >/dev/null && cd /tmp/miniclaw-demo && export PS1='\[\e[1;35m\]miniclaw-demo\[\e[0m\] $ ' && alias miniclaw='bun ~/Desktop/OpenClaw/src/index.ts' && clear"
Enter
Sleep 1s
Show

Type "miniclaw chat"
Enter
Wait@30s /you ›/
Sleep 1s
Type "/plan Create todo.md with 3 tasks for preparing the Friday demo, then list the folder"
Sleep 500ms
Enter
Wait@120s /Run this plan\?/
Sleep 4s
Type "y"
Enter
Wait@180s /you ›/
Sleep 4s
Type "/exit"
Enter
Sleep 1s
Type "cat workspace/todo.md"
Enter
Sleep 3s
