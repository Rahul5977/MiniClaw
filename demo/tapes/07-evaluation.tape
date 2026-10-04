# Scene 7: the test suite and the prompt-injection evaluation (worst case).
Output demo/out/07-evaluation.mp4
Source demo/tapes/_settings.tape

Hide
Type "cd ~/Desktop/OpenClaw && export PS1='\[\e[1;35m\]miniclaw\[\e[0m\] $ ' && clear"
Enter
Sleep 1s
Show

Type "bun test 2>&1 | grep -E '^ [0-9]+ (pass|fail)$|^Ran'"
Sleep 500ms
Enter
Wait@120s /\$\s*$/
Sleep 4s
Type "clear && demo/injection-table.sh"
Sleep 500ms
Enter
Wait@240s /\$\s*$/
Sleep 8s
