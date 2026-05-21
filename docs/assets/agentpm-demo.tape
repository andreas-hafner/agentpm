Output docs/assets/agentpm-demo.gif

Set FontSize 22
Set Width 1200
Set Height 720
Set Padding 20
Set Framerate 30
Set TypingSpeed 55ms
Set PlaybackSpeed 1
Set WaitTimeout 20s

Require node
Require git

Type "agentpm source add https://github.com/travelhawk/test-skills-vault.git"
Enter
Wait+Screen /✔ Added source/

Type "cd D:\\audio-editing"
Enter
Wait+Screen /audio-editing/

Type "agentpm search audacity"
Enter
Sleep 1000ms

Type "agentpm install audacity-align-tracks"
Enter
Sleep 500ms
Enter

Sleep 3500ms
Enter
Enter

Type "agentpm target add vault https://github.com/travelhawk/test-skills-vault.git --global"
Enter
Sleep 2200ms

Type 'agentpm push audio-mastering -m "Add new audio mastering skill"'
Enter
Sleep 5000ms

Type "Skill management made easy."
Sleep 2000ms
