# Citepath README demo, recorded with VHS (https://github.com/charmbracelet/vhs).
#
# Re-record:
#   1. Index the current Next.js docs into a separate demo index (takes a few minutes):
#        export CITEPATH_DEMO_DIR=/tmp/citepath-demo
#        CITEPATH_CONFIG=$CITEPATH_DEMO_DIR/config.json CITEPATH_DATA_DIR=$CITEPATH_DEMO_DIR/data \
#          citepath add nextjs --url https://nextjs.org/docs/app --include '/docs/app/**' \
#          --exclude '/docs/app/guides/upgrading/version-16' --sync
#      (version-16 is served as text/markdown, which the web adapter does not index yet.)
#   2. From the repository root, with CITEPATH_DEMO_DIR still set:
#        vhs docs/assets/demo.tape

Output docs/assets/demo.gif

Set Shell "zsh"
Set FontSize 16
Set Width 1200
Set Height 960
Set Padding 24
Set Theme "GitHub Dark"
Set TypingSpeed 45ms
Set WindowBar Colorful

Hide
Type `export CITEPATH_CONFIG="$CITEPATH_DEMO_DIR/config.json" CITEPATH_DATA_DIR="$CITEPATH_DEMO_DIR/data"`
Enter
Type "PS1='%F{green}$%f ' && clear"
Enter
Sleep 500ms
Show

# The Next.js docs were indexed beforehand with:
#   citepath add nextjs --url https://nextjs.org/docs/app --include '/docs/app/**' --sync
Type "citepath sources"
Sleep 400ms
Enter
Sleep 2.5s

Type 'citepath search "how do I set the cache lifetime" -n 2'
Sleep 500ms
Enter
Sleep 8s

Type "clear"
Enter
Type "citepath search cacheLife -n 1"
Sleep 500ms
Enter
Sleep 6s
