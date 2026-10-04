# Scene 6: flight recorder (I-8): every run is recorded and can be replayed without side effects.
Output demo/out/06-recorder.mp4
Source demo/tapes/_settings.tape

Hide
Type "demo/setup.sh >/dev/null && demo/seed-run.sh && cd /tmp/miniclaw-demo && export PS1='\[\e[1;35m\]miniclaw-demo\[\e[0m\] $ ' && alias miniclaw='bun ~/Desktop/OpenClaw/src/index.ts' && clear"
Enter
Wait@150s /\$\s*$/
Sleep 1s
Show

Type "miniclaw runs -n 5"
Enter
Sleep 4s
Type "miniclaw replay $(miniclaw runs -n 1 | cut -d' ' -f1) --times 3"
Sleep 500ms
Enter
Wait@240s /\$\s*$/
Sleep 5s
