# Scene 5: safety: risk rules (I-4), blocked commands, the panic button (I-9).
Output demo/out/05-safety.mp4
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
Type "Delete data.csv, I don't need it anymore."
Sleep 500ms
Enter
Wait@120s /Allow\?/
Sleep 4s
Type "n"
Enter
Wait@120s /you ›/
Sleep 3s
Type "Check which user I am logged in as, using sudo whoami."
Sleep 500ms
Enter
Wait@120s /Allow\?/
Sleep 4s
Type "y"
Enter
Wait@120s /you ›/
Sleep 3s
Type "/panic"
Enter
Sleep 2s
Type "Use the shell to list the files here with ls -la."
Sleep 500ms
Enter
Wait@120s /you ›/
Sleep 3s
Type "/status"
Enter
Sleep 4s
Type "/resume"
Enter
Sleep 2s
Type "/exit"
Enter
Sleep 1s
